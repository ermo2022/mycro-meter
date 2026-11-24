import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  base: '/mycro-meter/',
  plugins: [react(), basicSsl()],
  build: { chunkSizeWarningLimit: 600 },
})
