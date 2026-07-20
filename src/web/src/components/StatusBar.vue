<script setup lang="ts">
import { computed } from 'vue';
import type { ChatState } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ state: ChatState }>();

const statusText = computed(() => {
  switch (props.state.connectionStatus) {
    case 'connected':
      return '已连接';
    case 'reconnecting':
      return '重连中…';
    default:
      return '未连接';
  }
});

function onRetry(): void {
  chatApi.sendRetry('y');
}

function onExit(): void {
  if (window.confirm('确定要退出吗？')) {
    chatApi.sendExit();
  }
}
</script>

<template>
  <div class="status-bar">
    <div class="status-left">
      <span class="status-dot" :class="state.connectionStatus"></span>
      <span class="status-text">{{ statusText }}</span>
    </div>
    <div class="status-center">mycc chat</div>
    <div class="status-right">
      <button
        v-if="state.showRetry"
        class="retry-btn"
        :disabled="state.connectionStatus !== 'connected'"
        @click="onRetry"
      >Retry</button>
      <span v-if="state.connectionError" class="conn-error">{{ state.connectionError }}</span>
      <button
        class="verbose-btn"
        :class="{ on: state.verboseLogs }"
        :title="state.verboseLogs ? '正在显示全部日志，点击仅显示摘要' : '点击显示全部日志'"
        @click="chatApi.toggleVerboseLogs"
      >
        <!-- Eye icon: open eye when logs visible, eye-with-slash when hidden -->
        <svg v-if="state.verboseLogs" class="eye-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
        <svg v-else class="eye-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
        <span>详细日志</span>
      </button>
      <button
        class="exit-btn"
        :disabled="state.connectionStatus !== 'connected'"
        @click="onExit"
      >退出</button>
    </div>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #2e2e2e;
  color: #fff;
  font-size: 14px;
  flex-shrink: 0;
}
.status-left {
  display: flex;
  align-items: center;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}
.status-dot.connected {
  background: #07c160;
}
.status-dot.reconnecting {
  background: #faad14;
}
.status-dot.disconnected {
  background: #ff4d4f;
}
.status-center {
  font-weight: 600;
}
.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.retry-btn {
  background: #faad14;
  color: #000;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.retry-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.conn-error {
  color: #ff7875;
  font-size: 12px;
  padding: 0 4px;
}
.verbose-btn {
  background: #4a4a4a;
  color: #bbb;
  border: 1px solid #666;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s, color 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.verbose-btn:hover {
  background: #5a5a5a;
}
.verbose-btn.on {
  background: #07c160;
  color: #fff;
  border-color: #07c160;
}
.eye-icon {
  flex-shrink: 0;
}
.exit-btn {
  background: #ff4d4f;
  color: #fff;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.exit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>