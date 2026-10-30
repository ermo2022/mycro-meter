# Mycrometer Project Notes

- Stack: React, TypeScript, and Vite. Run `npm run dev` for local work and `npm run build` for verification.
- Keep image decoding, calibration, measurements, and exports client-side. Do not add an image upload backend.
- TIFF decoding uses UTIF and currently measures only the first page. Preserve pixel coordinates through any display conversion.
- Object detection uses lazily loaded OpenCV.js adaptive threshold contours without shape assumptions; keep it responsive on large images and preserve coordinates in source-image pixels.
- Detection may be restricted to a user-selected rectangular region; preserve source-image pixel coordinates when cropping and map detected boxes back to the full image.
- Detected minimum-area rotated boxes are candidates, not guaranteed segmentations. Users review box width, height, and orientation, and calibrate before recording physical dimensions.
- Preserve measurements across analysis-region changes and detection runs; clear them only on explicit user action or when loading a new image.
- Calibration stores pixels per selected physical unit; uncalibrated measurements remain in pixels.
- The service worker is registered only in production. Test offline behavior with a production preview after the first online load.
- Keep the measurement canvas usable on narrow screens and retain keyboard-visible focus styles for controls.