import humanFormat from 'human-format'
import ms from 'ms'
import { createLogger } from '@xen-orchestra/log'

const { warn } = createLogger('xo:server:handleBackupLog')

async function sendToNagios(app, jobName, vmBackupInfo) {
  if (app.sendPassiveCheck === undefined) {
    // Nagios plugin is not loaded
    return
  }

  try {
    const messageToNagios = {
      id: vmBackupInfo.id,
      result: vmBackupInfo.result,
      size: humanFormat.bytes(vmBackupInfo.size),
      duration: ms(vmBackupInfo.end - vmBackupInfo.start),
    }

    await app.sendPassiveCheck(
      {
        message: JSON.stringify(messageToNagios),
        status: 0,
      },
      app.getObject(messageToNagios.id).name_label,
      jobName
    )
  } catch (error) {
    warn('sendToNagios:', error)
  }
}

function forwardResult(log) {
  if (log.status === 'failure') {
    throw log.result
  }
  return log.result
}

// it records logs generated by `@xen-orchestra/backups/Task#run`
export const handleBackupLog = (
  log,
  { vmBackupInfo, app, jobName, logger, localTaskIds, rootTaskId, runJobId = rootTaskId, handleRootTaskId }
) => {
  const { event, message, parentId, taskId } = log

  if (app !== undefined && jobName !== undefined) {
    if (event === 'start') {
      if (log.data?.type === 'VM') {
        vmBackupInfo.set('vm-' + taskId, {
          id: log.data.id,
          start: log.timestamp,
        })
      } else if (vmBackupInfo.has('vm-' + parentId) && log.message === 'export') {
        vmBackupInfo.set('export-' + taskId, {
          parentId: 'vm-' + parentId,
        })
      } else if (vmBackupInfo.has('export-' + parentId) && log.message === 'transfer') {
        vmBackupInfo.set('transfer-' + taskId, {
          parentId: 'export-' + parentId,
        })
      }
    } else if (event === 'end') {
      if (vmBackupInfo.has('vm-' + taskId)) {
        const data = vmBackupInfo.get('vm-' + taskId)
        data.result = log.status
        data.end = log.timestamp
        sendToNagios(app, jobName, data)
      } else if (vmBackupInfo.has('transfer-' + taskId)) {
        vmBackupInfo.get(vmBackupInfo.get(vmBackupInfo.get('transfer-' + taskId).parentId).parentId).size =
          log.result.size
      }
    }
  }

  // If `runJobId` is defined, it means that the root task is already handled by `runJob`
  if (runJobId !== undefined) {
    // Ignore the start of the root task
    if (event === 'start' && log.parentId === undefined) {
      localTaskIds[taskId] = runJobId
      return
    }

    // Return/throw the result of the root task
    if (event === 'end' && localTaskIds[taskId] === runJobId) {
      return forwardResult(log)
    }
  }

  const common = {
    data: log.data,
    event: 'task.' + event,
    result: log.result,
    status: log.status,
  }

  if (event === 'start') {
    const { parentId } = log
    if (parentId === undefined) {
      handleRootTaskId((localTaskIds[taskId] = logger.notice(message, common)))
    } else {
      common.parentId = localTaskIds[parentId]
      localTaskIds[taskId] = logger.notice(message, common)
    }
  } else {
    common.taskId = localTaskIds[taskId]
    logger.notice(message, common)
  }

  // special case for the end of the root task: return/throw the result
  if (event === 'end' && localTaskIds[taskId] === rootTaskId) {
    return forwardResult(log)
  }
}
