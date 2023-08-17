import ipaddr from 'ipaddr.js'
import semver from 'semver'
import { createLogger } from '@xen-orchestra/log'
import filter from 'lodash/filter'
import find from 'lodash/find'
import isEmpty from 'lodash/isEmpty'
import keyBy from 'lodash/keyBy'
import pick from 'lodash/pick'
import pickBy from 'lodash/pickBy'
import some from 'lodash/some'
import trimEnd from 'lodash/trimEnd'

import diff from './diff'
import { deduplicateName } from './name-dedup'
import slugify from './slugify'

const log = createLogger('xo:netbox')

const CLUSTER_TYPE = 'XCP-ng Pool'
const TYPES_WITH_UUID = ['virtualization.cluster', 'virtualization.virtualmachine', 'virtualization.vminterface']
const CHUNK_SIZE = 100
export const NAME_MAX_LENGTH = 64
export const DESCRIPTION_MAX_LENGTH = 200
const REQUEST_TIMEOUT = 120e3 // 2min
const M = 1024 ** 2
const G = 1024 ** 3

const { push } = Array.prototype

// =============================================================================

export configurationSchema from './configuration-schema'
export default opts => new Netbox(opts)

// =============================================================================

class Netbox {
  #allowUnauthorized
  #endpoint
  #intervalToken
  #loaded
  #netboxApiVersion
  #xoPools
  #removeApiMethods
  #syncInterval
  #token
  #xo

  constructor({ xo }) {
    this.#xo = xo

    this.getObject = function getObject(id) {
      try {
        return this.#xo.getObject(id)
      } catch (err) {}
    }

    this.getObjects = xo.getObjects.bind(xo)
  }

  configure(configuration) {
    this.#endpoint = trimEnd(configuration.endpoint, '/')
    if (!/^https?:\/\//.test(this.#endpoint)) {
      this.#endpoint = 'http://' + this.#endpoint
    }
    this.#allowUnauthorized = configuration.allowUnauthorized ?? false
    this.#token = configuration.token
    this.#xoPools = configuration.pools
    this.#syncInterval = configuration.syncInterval && configuration.syncInterval * 60 * 60 * 1e3

    // We don't want to start the auto-sync if the plugin isn't loaded
    if (this.#loaded) {
      clearInterval(this.#intervalToken)
      if (this.#syncInterval !== undefined) {
        this.#intervalToken = setInterval(this.#synchronize.bind(this), this.#syncInterval)
      }
    }
  }

  load() {
    const synchronize = ({ pools }) => this.#synchronize(pools)
    synchronize.description = 'Synchronize XO pools with Netbox'
    synchronize.params = {
      pools: { type: 'array', optional: true, items: { type: 'string' } },
    }

    this.#removeApiMethods = this.#xo.addApiMethods({
      netbox: { synchronize },
    })

    if (this.#syncInterval !== undefined) {
      this.#intervalToken = setInterval(this.#synchronize.bind(this), this.#syncInterval)
    }

    this.#loaded = true
  }

  unload() {
    this.#removeApiMethods()
    clearInterval(this.#intervalToken)

    this.#loaded = false
  }

  async test() {
    const randomSuffix = Math.random().toString(36).slice(2, 11)
    const name = '[TMP] Xen Orchestra Netbox plugin test - ' + randomSuffix
    await this.#request('/virtualization/cluster-types/', 'POST', {
      name,
      slug: 'xo-test-' + randomSuffix,
      description:
        "This type has been created by Xen Orchestra's Netbox plugin test. If it hasn't been properly deleted, you may delete it manually.",
    })
    const nbClusterTypes = await this.#request(`/virtualization/cluster-types/?name=${encodeURIComponent(name)}`)

    await this.#checkCustomFields()

    if (nbClusterTypes.length !== 1) {
      throw new Error('Could not properly write and read Netbox')
    }

    await this.#request('/virtualization/cluster-types/', 'DELETE', [{ id: nbClusterTypes[0].id }])
  }

  async #request(path, method = 'GET', data) {
    if (data?.length === 0) {
      // Allows to call #request() without checking if data is empty and still
      // avoid empty requests
      return []
    }

    const dataDebug =
      Array.isArray(data) && data.length > 2 ? [...data.slice(0, 2), `and ${data.length - 2} others`] : data
    log.debug(`${method} ${path}`, dataDebug)

    let url = this.#endpoint + '/api' + path
    const options = {
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${this.#token}` },
      method,
      rejectUnauthorized: !this.#allowUnauthorized,
      timeout: REQUEST_TIMEOUT,
    }

    const httpRequest = async () => {
      try {
        const response = await this.#xo.httpRequest(url, options)
        this.#netboxApiVersion = response.headers['api-version']
        const body = await response.text()
        if (body.length > 0) {
          return JSON.parse(body)
        }
      } catch (error) {
        error.data = {
          method,
          path,
          body: dataDebug,
        }
        try {
          const body = await error.response.text()
          if (body.length > 0) {
            error.data.error = JSON.parse(body)
          }
        } catch {
          throw error
        }
        throw error
      }
    }

    let response = []
    // Split long POST request into chunks of CHUNK_SIZE objects to avoid a Bad Gateway errors
    if (Array.isArray(data)) {
      let offset = 0
      while (offset < data.length) {
        options.body = JSON.stringify(data.slice(offset, offset + CHUNK_SIZE))
        push.apply(response, await httpRequest())
        offset += CHUNK_SIZE
      }
    } else {
      if (data !== undefined) {
        options.body = JSON.stringify(data)
      }
      response = await httpRequest()
    }

    if (method !== 'GET') {
      return response
    }

    // Handle pagination for GET requests
    const { results } = response
    while (response.next !== null) {
      const { pathname, search } = new URL(response.next)
      url = this.#endpoint + pathname + search
      response = await httpRequest()
      push.apply(results, response.results)
    }

    return results
  }

  async #checkCustomFields() {
    const customFields = await this.#request('/extras/custom-fields/')
    const uuidCustomField = customFields.find(field => field.name === 'uuid')
    if (uuidCustomField === undefined) {
      throw new Error('UUID custom field was not found. Please create it manually from your Netbox interface.')
    }
    const { content_types: types } = uuidCustomField
    if (TYPES_WITH_UUID.some(type => !types.includes(type))) {
      throw new Error('UUID custom field must be assigned to types ' + TYPES_WITH_UUID.join(', '))
    }
  }

  // ---------------------------------------------------------------------------

  async #synchronize(xoPools = this.#xoPools) {
    await this.#checkCustomFields()

    log.info(`Synchronizing ${xoPools.length} pools with Netbox`, { pools: xoPools })

    // Cluster type ------------------------------------------------------------

    // Create a single cluster type called "XCP-ng Pool" to identify clusters
    // that have been created from XO

    // Check if a cluster type called XCP-ng already exists otherwise create it
    const nbClusterTypes = await this.#request(
      `/virtualization/cluster-types/?name=${encodeURIComponent(CLUSTER_TYPE)}`
    )
    if (nbClusterTypes.length > 1) {
      throw new Error('Found more than 1 "XCP-ng Pool" cluster type')
    }
    let nbClusterType
    if (nbClusterTypes.length === 0) {
      log.info('Creating cluster type')
      nbClusterType = await this.#request('/virtualization/cluster-types/', 'POST', {
        name: CLUSTER_TYPE,
        slug: slugify(CLUSTER_TYPE),
        description: 'Created by Xen Orchestra',
      })
    } else {
      nbClusterType = nbClusterTypes[0]
    }

    // Clusters ----------------------------------------------------------------

    // Update and create clusters. Deleting a cluster is manual action.

    log.info('Synchronizing clusters')

    const createNbCluster = (xoPool, nbClusterType) => ({
      custom_fields: { uuid: xoPool.uuid },
      name: xoPool.name_label.slice(0, NAME_MAX_LENGTH),
      type: nbClusterType.id,
    })

    // { Pool UUID → cluster }
    const allNbClusters = keyBy(
      await this.#request(`/virtualization/clusters/?type_id=${nbClusterType.id}`),
      'custom_fields.uuid'
    )
    const nbClusters = pick(allNbClusters, xoPools)

    if (allNbClusters[undefined] !== undefined) {
      // Show a warning but never delete clusters automatically
      log.warn('Found some clusters with missing UUID custom field', allNbClusters[undefined])
    }

    const clustersToCreate = []
    const clustersToUpdate = []
    for (const xoPoolId of xoPools) {
      const xoPool = this.getObject(xoPoolId)
      if (xoPool === undefined) {
        // If we can't find the pool, don't synchronize anything within that pool
        log.warn('Synchronizing pools: cannot find pool', { pool: xoPoolId })
        delete allNbClusters[xoPoolId]
        delete nbClusters[xoPoolId]
        continue
      }
      const nbCluster = nbClusters[xoPool.uuid]

      const updatedCluster = createNbCluster(xoPool, nbClusterType)

      if (nbCluster === undefined) {
        clustersToCreate.push(updatedCluster)
      } else {
        // `type` needs to be flattened so we can compare the 2 objects
        const patch = diff(updatedCluster, { ...nbCluster, type: nbCluster.type.id })
        if (patch !== undefined) {
          clustersToUpdate.push(patch)
        }
      }
    }

    const newClusters = []
    newClusters.push(...(await this.#request('/virtualization/clusters/', 'PATCH', clustersToUpdate)))
    newClusters.push(...(await this.#request('/virtualization/clusters/', 'POST', clustersToCreate)))

    Object.assign(nbClusters, keyBy(newClusters, 'custom_fields.uuid'))
    Object.assign(allNbClusters, nbClusters)

    if (isEmpty(nbClusters)) {
      // Stop the synchronization if no pools could be found. Most likely, the
      // objects are not fetched or the pools have been disconnected.
      log.warn('Pools not found in XO', { pools: xoPools })
      return
    }

    // Only keep pools that were found in XO and up to date in Netbox
    xoPools = Object.keys(nbClusters)

    const allClusterFilter = Object.values(allNbClusters)
      .map(cluster => `cluster_id=${cluster.id}`)
      .join('&')

    const clusterFilter = Object.values(nbClusters)
      .map(nbCluster => `cluster_id=${nbCluster.id}`)
      .join('&')

    // VMs ---------------------------------------------------------------------

    log.info('Synchronizing VMs')

    const createNbVm = async (xoVm, { nbCluster, nbPlatforms, nbTags }) => {
      const nbVm = {
        custom_fields: { uuid: xoVm.uuid },
        name: xoVm.name_label.slice(0, NAME_MAX_LENGTH).trim(),
        comments: xoVm.name_description.slice(0, DESCRIPTION_MAX_LENGTH).trim(),
        vcpus: xoVm.CPUs.number,
        disk: Math.floor(
          xoVm.$VBDs
            .map(vbdId => this.getObject(vbdId))
            .filter(vbd => !vbd.is_cd_drive)
            .map(vbd => this.getObject(vbd.VDI))
            .reduce((total, vdi) => total + vdi.size, 0) / G
        ),
        memory: Math.floor(xoVm.memory.dynamic[1] / M),
        cluster: nbCluster.id,
        status: xoVm.power_state === 'Running' ? 'active' : 'offline',
        platform: null,
        tags: [],
      }

      const distro = xoVm.os_version?.distro
      if (distro != null) {
        const slug = slugify(distro)
        let nbPlatform = find(nbPlatforms, { slug })
        if (nbPlatform === undefined) {
          // TODO: Should we also delete/update platforms in Netbox?
          nbPlatform = await this.#request('/dcim/platforms/', 'POST', {
            name: distro,
            slug,
          })
          nbPlatforms[nbPlatform.id] = nbPlatform
        }

        nbVm.platform = nbPlatform.id
      }

      const nbVmTags = []
      for (const tag of xoVm.tags) {
        const slug = slugify(tag)
        let nbTag = find(nbTags, { slug })
        if (nbTag === undefined) {
          // TODO: Should we also delete/update tags in Netbox?
          nbTag = await this.#request('/extras/tags/', 'POST', {
            name: tag,
            slug,
            color: '2598d9',
            description: 'XO tag',
          })
          nbTags[nbTag.id] = nbTag
        }

        // Edge case: tags "foo" and "Foo" would have the same slug. It's
        // allowed in XO but not in Netbox so in that case, we only add it once
        // to Netbox.
        if (!some(nbVmTags, { id: nbTag.id })) {
          nbVmTags.push({ id: nbTag.id })
        }
      }

      // Sort them so that they can be compared by diff()
      nbVm.tags = nbVmTags.sort(({ id: id1 }, { id: id2 }) => (id1 < id2 ? -1 : 1))

      // https://netbox.readthedocs.io/en/stable/release-notes/version-2.7/#api-choice-fields-now-use-string-values-3569
      if (
        this.#netboxApiVersion !== undefined &&
        !semver.satisfies(semver.coerce(this.#netboxApiVersion).version, '>=2.7.0')
      ) {
        nbVm.status = xoVm.power_state === 'Running' ? 1 : 0
      }

      return nbVm
    }

    // Some props need to be flattened to satisfy the POST request schema
    const flattenNested = nbVm => ({
      ...nbVm,
      cluster: nbVm.cluster?.id ?? null,
      status: nbVm.status?.value ?? null,
      platform: nbVm.platform?.id ?? null,
      // Sort them so that they can be compared by diff()
      tags: nbVm.tags.map(nbTag => ({ id: nbTag.id })).sort(({ id: id1 }, { id: id2 }) => (id1 < id2 ? -1 : 1)),
    })

    const nbPlatforms = keyBy(await this.#request('/dcim/platforms/'), 'id')
    const nbTags = keyBy(await this.#request('/extras/tags/'), 'id')

    // Get all the VMs in the cluster type "XCP-ng Pool" even from clusters
    // we're not synchronizing right now, so we can "migrate" them back if
    // necessary
    const allNbVmsList = await this.#request('/virtualization/virtual-machines/?' + allClusterFilter)
    // Then get only the ones from the pools we're synchronizing
    const nbVmsList = allNbVmsList.filter(nbVm => some(nbClusters, { id: nbVm.cluster.id }))
    // Then make them objects to map the Netbox VMs to their XO VMs
    // { VM UUID → Netbox VM }
    const allNbVms = keyBy(allNbVmsList, 'custom_fields.uuid')
    const nbVms = keyBy(nbVmsList, 'custom_fields.uuid')

    const usedNames = [] // Used for name deduplication
    // Build the 3 collections of VMs and perform all the API calls at the end
    const vmsToDelete = nbVmsList.filter(nbVm => nbVm.custom_fields.uuid == null).map(nbVm => ({ id: nbVm.id }))
    const vmsToUpdate = []
    const vmsToCreate = []
    for (const xoPoolId of xoPools) {
      // Get XO VMs that are on this pool
      const xoPoolVms = this.getObjects({ filter: { type: 'VM', $pool: xoPoolId } })

      const nbCluster = nbClusters[xoPoolId]

      // Get Netbox VMs that are supposed to be in this pool
      const xoPoolNbVms = pickBy(nbVms, nbVm => nbVm.cluster.id === nbCluster.id)

      // For each XO VM of this pool (I)
      for (const xoVm of Object.values(xoPoolVms)) {
        // Grab the Netbox VM from the list of all VMs so that if the VM is on
        // another cluster, we update the existing object instead of creating a
        // new one
        const nbVm = allNbVms[xoVm.uuid]
        delete xoPoolNbVms[xoVm.uuid]

        const updatedVm = await createNbVm(xoVm, { nbCluster, nbPlatforms, nbTags })

        if (nbVm !== undefined) {
          // VM found in Netbox: update VM (I.1)
          const patch = diff(updatedVm, flattenNested(nbVm))
          if (patch !== undefined) {
            vmsToUpdate.push(patch)
          } else {
            // The VM is up to date, just store its name as being used
            usedNames.push(nbVm.name)
          }
        } else {
          // VM not found in Netbox: create VM (I.2)
          vmsToCreate.push(updatedVm)
        }
      }

      // For each REMAINING Netbox VM of this pool (II)
      for (const nbVm of Object.values(xoPoolNbVms)) {
        const xoVmUuid = nbVm.custom_fields?.uuid
        const xoVm = this.getObject(xoVmUuid)
        // We check if the VM was moved to another pool in XO
        const xoPool = this.getObject(xoVm?.$pool)
        const nbCluster = allNbClusters[xoPool?.uuid]
        if (nbCluster !== undefined) {
          // If the VM is found in XO: update it if necessary (II.1)
          const updatedVm = await createNbVm(xoVm, { nbCluster, nbPlatforms, nbTags })
          const patch = diff(updatedVm, flattenNested(nbVm))

          if (patch === undefined) {
            // Should never happen since at least the cluster should be different
            log.warn('Found a VM that should be on another cluster', { vm: nbVm })
            continue
          }

          vmsToUpdate.push(patch)
        } else {
          // Otherwise, delete it from Netbox (II.2)
          vmsToDelete.push({ id: nbVm.id })
          delete nbVms[xoVmUuid]
        }
      }
    }

    // Deduplicate VM names
    // Deduplicate vmsToUpdate first to avoid back and forth changes
    // Deduplicate even between pools to simplify and avoid back and forth
    //   changes if the VM is migrated
    for (const nbVm of [...vmsToUpdate, ...vmsToCreate]) {
      if (nbVm.name === undefined) {
        continue
      }
      nbVm.name = deduplicateName(nbVm.name, usedNames)
      usedNames.push(nbVm.name)
    }

    // Perform calls to Netbox. "Delete → Update → Create" one at a time to
    // avoid name conflicts with outdated VMs
    const newVms = []

    await this.#request('/virtualization/virtual-machines/', 'DELETE', vmsToDelete)
    newVms.push(...(await this.#request('/virtualization/virtual-machines/', 'PATCH', vmsToUpdate)))
    newVms.push(...(await this.#request('/virtualization/virtual-machines/', 'POST', vmsToCreate)))

    Object.assign(nbVms, keyBy(newVms, 'custom_fields.uuid'))
    Object.assign(allNbVms, nbVms)

    // VIFs --------------------------------------------------------------------

    log.info('Synchronizing VIFs')

    const createNbIf = (xoVif, xoVm) => {
      const name = `eth${xoVif.device}`
      const nbVm = nbVms[xoVm.uuid]

      const nbIf = {
        custom_fields: { uuid: xoVif.uuid },
        name,
        mac_address: xoVif.MAC.toUpperCase(),
      }

      if (nbVm !== undefined) {
        nbIf.virtual_machine = nbVm.id
      }

      return nbIf
    }

    const nbIfsList = await this.#request(`/virtualization/interfaces/?${clusterFilter}`)
    // { ID → Interface }
    const nbIfs = keyBy(nbIfsList, 'custom_fields.uuid')

    const ifsToDelete = nbIfsList.filter(nbIf => nbIf.custom_fields.uuid == null).map(nbIf => ({ id: nbIf.id }))
    const ifsToUpdate = []
    const ifsToCreate = []
    for (const nbVm of Object.values(nbVms)) {
      const xoVm = this.getObject(nbVm.custom_fields.uuid)
      if (xoVm === undefined) {
        log.warn('Synchronizing VIFs: cannot find VM from UUID custom field', { vm: nbVm.custom_fields.uuid })
        continue
      }
      // Start by deleting old interfaces attached to this Netbox VM
      Object.entries(nbIfs).forEach(([id, nbIf]) => {
        if (nbIf.virtual_machine.id === nbVm.id && !xoVm.VIFs.includes(nbIf.custom_fields.uuid)) {
          ifsToDelete.push({ id: nbIf.id })
          delete nbIfs[id]
        }
      })

      // For each XO VIF, create or update the Netbox interface
      for (const xoVifId of xoVm.VIFs) {
        const xoVif = this.getObject(xoVifId)
        const nbIf = nbIfs[xoVif.uuid]
        const updatedIf = createNbIf(xoVif, xoVm)
        if (nbIf === undefined) {
          ifsToCreate.push(updatedIf)
        } else {
          // `virtual_machine` needs to be flattened so we can compare the 2 objects
          const patch = diff(updatedIf, { ...nbIf, virtual_machine: nbIf.virtual_machine.id })
          if (patch !== undefined) {
            ifsToUpdate.push(patch)
          }
        }
      }
    }

    // Perform calls to Netbox
    const newIfs = []
    await this.#request('/virtualization/interfaces/', 'DELETE', ifsToDelete)
    newIfs.push(...(await this.#request('/virtualization/interfaces/', 'PATCH', ifsToUpdate)))
    newIfs.push(...(await this.#request('/virtualization/interfaces/', 'POST', ifsToCreate)))

    Object.assign(nbIfs, keyBy(newIfs, 'custom_fields.uuid'))

    // IPs ---------------------------------------------------------------------

    log.info('Synchronizing IP addresses')

    const createNbIp = (ip, prefix, nbIf) => {
      return {
        address: `${ip}/${prefix.split('/')[1]}`,
        assigned_object_type: 'virtualization.vminterface',
        assigned_object_id: nbIf,
      }
    }

    // In Netbox, a device interface and a VM interface can have the same ID and
    // an IP address can be assigned to both types of interface, so we need to
    // make sure that we only get IPs that are assigned to a VM interface
    const nbIps = keyBy(
      (await this.#request('/ipam/ip-addresses/')).filter(
        address => address.assigned_object_type === 'virtualization.vminterface'
      ),
      'id'
    )
    const nbPrefixes = await this.#request('/ipam/prefixes/')

    const ipsToDelete = []
    const ipsToCreate = []
    const ignoredIps = [] // IPs for which a valid prefix could not be found in Netbox
    // For each VM, for each interface, for each IP: create IP in Netbox
    for (const nbVm of Object.values(nbVms)) {
      const xoVm = this.getObject(nbVm.custom_fields.uuid)
      if (xoVm === undefined) {
        log.warn('Synchronizing IPs: cannot find VM from UUID custom field', { vm: nbVm.custom_fields.uuid })
        continue
      }

      // Find the Netbox interface associated with the vif
      const nbVmIfs = filter(nbIfs, { virtual_machine: { id: nbVm.id } })
      for (const nbIf of nbVmIfs) {
        // Store old IPs and remove them one by one. At the end, delete the remaining ones.
        const nbIpsToCheck = pickBy(nbIps, nbIp => nbIp.assigned_object_id === nbIf.id)

        const xoVif = this.getObject(nbIf.custom_fields.uuid)
        if (xoVif === undefined) {
          // Cannot create IPs if interface was not found
          log.warn('Could not find VIF', { vm: xoVm.uuid, vif: nbIf.custom_fields.uuid })
          continue
        }
        const ips = Object.values(pickBy(xoVm.addresses, (_, key) => key.startsWith(xoVif.device + '/')))
        for (const ip of ips) {
          let parsedIp
          try {
            parsedIp = ipaddr.parse(ip)
          } catch (error) {
            log.error('Cannot parse IP address', { error, ip })
            ignoredIps.push({ vm: xoVm.uuid, ip, reason: 'Cannot parse IP address' })
            continue
          }
          const ipKind = parsedIp.kind()

          // Find the smallest prefix within Netbox's existing prefixes
          // Users must create prefixes themselves
          let smallestPrefix
          let highestBits = 0
          nbPrefixes.forEach(({ prefix }) => {
            const [range, bits] = prefix.split('/')
            let parsedRange
            try {
              parsedRange = ipaddr.parse(range)
            } catch (error) {
              log.error('Cannot parse range', { error, range })
              return
            }
            if (parsedRange.kind() === ipKind && parsedIp.match(parsedRange, bits) && bits > highestBits) {
              smallestPrefix = prefix
              highestBits = bits
            }
          })

          if (smallestPrefix === undefined) {
            // A valid prefix is required to create an IP in Netbox. If none matches, ignore the IP.
            ignoredIps.push({ vm: xoVm.uuid, ip, reason: 'No prefix found for this IP' })
            continue
          }

          const xoCompactIp = parsedIp.toString() // use compact notation (e.g. ::1) before ===-comparison
          const nbIp = find(nbIpsToCheck, nbIp => {
            const [ip, bits] = nbIp.address.split('/')
            let nbCompactIp
            try {
              nbCompactIp = ipaddr.parse(ip).toString()
            } catch (error) {
              log.error('Cannot parse IP address', { error, ip })
              return false
            }
            return nbCompactIp === xoCompactIp && bits === highestBits
          })
          if (nbIp !== undefined) {
            // IP is up to date, don't do anything with it
            delete nbIpsToCheck[nbIp.id]
          } else {
            // IP wasn't found in Netbox, create it
            ipsToCreate.push(createNbIp(ip, smallestPrefix, nbIf.id))
          }
        }

        // Delete the remaining IPs found in Netbox for this VM
        ipsToDelete.push(...Object.values(nbIpsToCheck).map(nbIp => ({ id: nbIp.id })))
      }
    }

    if (ignoredIps.length > 0) {
      // Only show the first ignored IP in order to not flood logs if there are
      // many and it should be enough to fix the issues one by one
      log.warn(`Could not synchronize ${ignoredIps.length} IP addresses`, ignoredIps[0])
    }

    // Perform calls to Netbox
    await this.#request('/ipam/ip-addresses/', 'DELETE', ipsToDelete)
    ipsToDelete.forEach(({ id }) => delete nbIps[id])
    Object.assign(nbIps, keyBy(await this.#request('/ipam/ip-addresses/', 'POST', ipsToCreate), 'id'))

    // Primary IPs -------------------------------------------------------------

    // Use the first IPs found in vm.addresses as the VMs' primary IPs in
    // Netbox, both for IPv4 and IPv6

    log.info("Setting VMs' primary IPs")

    const vmsToUpdate2 = []
    for (const nbVm of Object.values(nbVms)) {
      const xoVm = this.getObject(nbVm.custom_fields.uuid)
      if (xoVm === undefined) {
        log.warn('Updating primary IPs: cannot find VM from UUID custom field', { vm: nbVm.custom_fields.uuid })
        continue
      }
      const patch = { id: nbVm.id }

      const nbVmIps = filter(nbIps, { assigned_object: { virtual_machine: { id: nbVm.id } } })

      const ipv4 = xoVm.addresses['0/ipv4/0']
      if (ipv4 === undefined && nbVm.primary_ip4 !== null) {
        patch.primary_ip4 = null
      } else if (ipv4 !== undefined) {
        // Find an IP in Netbox that matches the XO IP
        const nbIp = nbVmIps.find(nbIp => nbIp.address.split('/')[0] === ipv4)
        if (nbIp === undefined && nbVm.primary_ip4 !== null) {
          // If the IP couldn't be found in Netbox but the VM is still assigned a
          // primary IP, it means it's the wrong IP so delete it
          patch.primary_ip4 = null
        } else if (nbIp !== undefined && nbIp.id !== nbVm.primary_ip4?.id) {
          // If an IP was found in Netbox, make sure it's the one assigned as
          // primary IP otherwise update the VM
          patch.primary_ip4 = nbIp.id
        }
      }

      const _ipv6 = xoVm.addresses['0/ipv6/0']
      let ipv6
      try {
        // For IPv6, compare with the compact notation
        ipv6 = _ipv6 && ipaddr.parse(_ipv6).toString()
      } catch (error) {
        log.error('Cannot parse IP address', { error, ip: _ipv6 })
      }
      if (ipv6 === undefined && nbVm.primary_ip6 !== null) {
        patch.primary_ip6 = null
      } else if (ipv6 !== undefined) {
        const nbIp = nbVmIps.find(nbIp => nbIp.address.split('/')[0] === ipv6)
        if (nbIp === undefined && nbVm.primary_ip6 !== null) {
          patch.primary_ip6 = null
        } else if (nbIp !== undefined && nbIp.id !== nbVm.primary_ip6?.id) {
          patch.primary_ip6 = nbIp.id
        }
      }

      if (patch.primary_ip4 !== undefined || patch.primary_ip6 !== undefined) {
        vmsToUpdate2.push(patch)
      }
    }

    Object.assign(nbVms, keyBy(await this.#request('/virtualization/virtual-machines/', 'PATCH', vmsToUpdate2)))

    log.info(`Done synchronizing ${xoPools.length} pools with Netbox`, { pools: xoPools })
  }
}
