declare module 'utif' {
  type TiffPage = { width: number; height: number }

  export function decode(buffer: ArrayBuffer): TiffPage[]
  export function decodeImage(buffer: ArrayBuffer, page: TiffPage): void
  export function toRGBA8(page: TiffPage): Uint8Array
}