<!-- WIP -->
<template>
  <div :class="{ mobile: isMobile }" class="ui-quick-task-panel">
    <VtsQuickTaskTabBar
      v-model="currentTab"
      :failure-count="failureTasks.length"
      :loading
      :pending-count="pendingTasks.length"
      :success-count="successTasks.length"
    />
    <VtsQuickTaskList :loading :tasks="currentTasks" />
  </div>
</template>

<script lang="ts" setup>
import VtsQuickTaskList from '@core/components/task/VtsQuickTaskList.vue'
import VtsQuickTaskTabBar, { type TaskTab } from '@core/components/task/VtsQuickTaskTabBar.vue'
import type { Task } from '@core/components/ui/quick-task-item/UiQuickTaskItem.vue'
import { useUiStore } from '@core/stores/ui.store'
import { computed, ref } from 'vue'

const props = defineProps<{
  tasks: Task[]
  loading?: boolean
}>()

const { isMobile } = useUiStore()

const currentTab = ref<TaskTab>('pending')

const pendingTasks = computed(() => props.tasks.filter(task => task.status === 'pending'))
const successTasks = computed(() => props.tasks.filter(task => task.status === 'success'))
const failureTasks = computed(() => props.tasks.filter(task => task.status === 'failure'))

const currentTasks = computed(() => {
  switch (currentTab.value) {
    case 'pending':
      return pendingTasks.value
    case 'success':
      return successTasks.value
    case 'failure':
      return failureTasks.value
    case 'all':
      return props.tasks
    default:
      return []
  }
})
</script>

<style lang="postcss" scoped>
.ui-quick-task-panel {
  width: fit-content;
  min-width: 65rem;
  border-radius: 0.8rem;
  overflow: hidden;
  border: 0.1rem solid var(--color-neutral-border);
  z-index: 1001;

  &.mobile {
    width: 100%;
    min-width: 0;
    border-radius: 0;
  }
}
</style>
