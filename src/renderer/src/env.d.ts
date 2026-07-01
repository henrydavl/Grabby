/// <reference types="vite/client" />
import type { GrabbyAPI } from '../../shared/types'

declare global {
  interface Window {
    grabby: GrabbyAPI
  }
}

export {}
