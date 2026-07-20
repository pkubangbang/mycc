<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ChatState, FileInfo } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ state: ChatState }>();

const text = ref(props.state.inputText);
const fileInput = ref<HTMLInputElement | null>(null);
const localFiles = ref<FileInfo[]>([]);
const dragOver = ref(false);
let dragCounter = 0;

watch(
  () => props.state.inputText,
  (val) => {
    if (val !== text.value) text.value = val;
  },
);

watch(text, (val) => {
  props.state.inputText = val;
});

watch(
  () => props.state.pendingFiles,
  (val) => {
    localFiles.value = val;
  },
);

function openFilePicker(): void {
  fileInput.value?.click();
}

function readFiles(rawFiles: FileList): void {
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      const info: FileInfo = {
        filename: file.name,
        data: base64,
        mimeType: file.type || 'application/octet-stream',
      };
      localFiles.value = [...localFiles.value, info];
      props.state.pendingFiles = localFiles.value;
    };
    reader.readAsDataURL(file);
  }
}

function onFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const rawFiles = input.files;
  if (!rawFiles || rawFiles.length === 0) return;
  readFiles(rawFiles);
  input.value = '';
}

function removeFile(index: number): void {
  localFiles.value.splice(index, 1);
  props.state.pendingFiles = localFiles.value;
}

function send(): void {
  const value = text.value;
  const files = localFiles.value.length > 0 ? [...localFiles.value] : undefined;
  if (!value.trim() && !files) return;
  if (props.state.isWaiting || props.state.showRetry) {
    chatApi.sendInput(value, files);
  } else if (props.state.isRunning) {
    chatApi.sendSteer(value, files);
  }
  text.value = '';
  localFiles.value = [];
  props.state.pendingFiles = [];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function onDragEnter(event: DragEvent): void {
  event.preventDefault();
  dragCounter++;
  dragOver.value = true;
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dragOver.value = false;
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragCounter = 0;
  dragOver.value = false;
  if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
    readFiles(event.dataTransfer.files);
  }
}
</script>

<template>
  <div
    class="chat-input"
    :class="{ 'drag-over': dragOver }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="input-row">
      <div class="input-area-wrapper">
        <textarea
          v-model="text"
          class="input-area"
          :placeholder="state.isWaiting ? '输入消息…' : '等待回复中…'"
          :disabled="(!state.isWaiting && !state.isRunning) || state.connectionStatus !== 'connected'"
          rows="2"
          @keydown="onKeydown"
        ></textarea>
        <button
          class="attach-btn"
          :disabled="(!state.isWaiting && !state.isRunning) || state.connectionStatus !== 'connected'"
          title="附加文件"
          @click="openFilePicker"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="file-input-hidden"
        @change="onFilesSelected"
      />
      <button
        class="send-btn"
        :disabled="(!text.trim() && localFiles.length === 0) || (!state.isWaiting && !state.showRetry && !state.isRunning) || state.connectionStatus !== 'connected'"
        @click="send"
      >发送</button>
    </div>
    <div v-if="localFiles.length > 0" class="file-chips">
      <span
        v-for="(f, i) in localFiles"
        :key="i"
        class="file-chip"
      >
        <span class="file-chip-name">{{ f.filename }}</span>
        <button class="file-chip-remove" @click="removeFile(i)">&times;</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  flex-direction: column;
  padding: 8px 16px 16px;
  background: var(--bg-input);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  transition: background 0.15s;
}
.chat-input.drag-over {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
}
.input-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.input-area-wrapper {
  position: relative;
  flex: 1;
  display: flex;
}
.input-area {
  flex: 1;
  resize: none;
  border: 1px solid var(--border-input);
  border-radius: 6px;
  padding: 8px 34px 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  max-height: 120px;
  outline: none;
  background: var(--bg-input-field);
  color: var(--text-primary);
}
.input-area:focus {
  border-color: var(--accent);
}
.input-area:disabled {
  background: var(--bg-input-field-disabled);
  color: var(--text-input-disabled);
}
.attach-btn {
  position: absolute;
  right: 2px;
  bottom: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input-field);
  color: var(--text-muted);
  border: none;
  border-radius: 4px;
  padding: 4px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.attach-btn:hover:not(:disabled) {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-input-field));
}
.attach-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.file-input-hidden {
  display: none;
}
.send-btn {
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  height: 40px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
.send-btn:disabled {
  background: var(--accent-disabled);
  cursor: not-allowed;
}
.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent);
  color: var(--accent-text);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  max-width: 200px;
}
.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-chip-remove {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  margin-left: 2px;
  opacity: 0.8;
}
.file-chip-remove:hover {
  opacity: 1;
}
</style>
