/// <reference types="vite/client" />

declare const Buffer: {
  from(buffer: ArrayBuffer): { toString(encoding: 'base64'): string };
} | undefined;
