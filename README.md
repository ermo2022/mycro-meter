# Mycrometer

Mycrometer is a browser-based PWA for measuring distances in microscope images. Images and measurements stay on the device; there is no upload service.

Try the [latest hosted version on GitHub Pages](https://ermo2022.github.io/mycro-meter/).

## Features

- Open PNG, JPEG, WebP, and TIFF images. TIFF files are decoded locally and the first page is used.
- Image imports are limited to 100 MiB and 40 megapixels; session CSV imports are limited to 10 MiB and 10,000 measurements.
- Calibrate against a known scale-bar length in micrometres, millimetres, or nanometres.
- Detect contrast-based object contours and fit minimum-area rotated rectangles to record width, height, and orientation.
- Click an object in measure mode to detect a single editable box near that point, or drag to draw a manual box.
- Summarize spore length, width, and Q with mean ± sample SD and D1–D9 percentile ranges, including the number of boxes used.
- After calibration, draw manual measurement boxes and refine their rotation and dimensions.
- Zoom, pan, undo, remove individual measurements, clear the list, and export measurements as CSV.
- Optionally crop and resample before calibration, using lossless PNG encoding, high-quality interpolation, and at most 1.5x scale reduction. Native resolution is the default.
- After successful calibration, automatically save images, calibration, editable geometry, and CSV data together in IndexedDB. Reopen them from **Saved projects** without selecting the image again; each session and set shows its estimated storage size.
- Export/import individual sessions or named multi-image sets as uncompressed ZIP projects containing readable JSON, CSV, and PNG files. Legacy session CSV imports remain supported.
- Combine calibrated measurements from multiple images in a measurement set, with pooled statistics, unit conversion, and a combined CSV export.
- Install as a PWA and use the app shell offline after the first online visit.
- Switch the interface between English and Dutch; the selected language is remembered on this device.

## Use

1. Select **Open image** and choose a microscope image. Use **Replace image** to switch files or **Unload** to clear the current image, calibration, and measurements.
2. The calibration tool is selected automatically. Click both ends of a known scale bar; pan and zoom remain available to reach it.
3. Enter its real-world length and unit, then choose **Set scale**. Recalibration preserves measurements and updates their physical values from the original pixel geometry.
4. In **Measure object** mode, click an object to detect a single box around it. The detector searches near the click, tries dark and bright foregrounds automatically, and expands its temporary crop when needed. There are no persistent detection areas or candidate lists. Drag instead of clicking to draw a manual box.
5. Refine the initial box's edges or corners and rotate it with the round handle, then choose **Accept dimensions**. The box is only a draft until accepted: **Cancel**, Escape, or closing the editor removes it without adding a measurement. After acceptance, measure mode stays active for the next object. Use the select tool to edit a saved box on the image, or click a measurement in the list. Canceling an existing measurement edit preserves the saved measurement. Length is always the longer box dimension; axes are swapped automatically when needed, so Q is always at least 1 in measurements, summaries, and exports. Clear measurements explicitly when finished, or load a new image to reset the workspace.
6. Once you set a valid calibration, the image and accepted measurement changes save locally automatically; check the save status beneath the export controls. Opening or cropping an image does not save it before calibration. Uncalibrated ZIP imports also remain temporary until calibrated. Use **Saved projects** to reopen a session after refreshing or closing the app. Each session and set displays an estimated size for its PNG images and serialized metadata/CSV; browser database overhead, compression, and deduplication are not reflected. **Export CSV** remains available for spreadsheet values. Without an active set, the bottom **Export session** button downloads a ZIP containing the current image, calibration, geometry, and CSV. Once a set contains images, the primary bottom action becomes **Export set**, downloading the entire set under its name; **Export current session** remains available beneath it to download only the current image and its data. **Import project** restores session/set ZIPs, or accepts legacy session CSVs together with their images.

Controls appear as their prerequisites become available: loading an image reveals calibration, pan/zoom, and cropping; calibration reveals detection, measuring, and session export; accepted measurements reveal editing, values-only CSV export, and set creation. Spore summaries appear only for calibrated box measurements. Imported uncalibrated measurements remain visible in pixels, and an existing set remains accessible for reopening and exporting even without a calibrated current image. Opening images and saved projects, importing projects, and changing language remain available throughout.

Before calibration, the crop icon beside **Fit view** opens a preview with a draggable crop and exact pixel fields. Draw a selection, drag its edges or corners to resize it, or drag inside to reposition it. Handles also support arrow keys (Shift for 10-pixel steps). Choose a reduction factor from 1 to 1.5; encoding is PNG with high-quality interpolation. Resampling changes image detail even though PNG encoding is lossless. Rounded output dimensions use uniform scaling to avoid stretching, clipping at most a fractional pixel at the output edge. Applying a crop creates a new temporary session, saved only after successful calibration; the uncalibrated original is not automatically stored. Calibration and measurements then use the processed image's pixel coordinates. Cropping is hidden after calibration or recording measurements to prevent invalidating existing geometry.

Calibration is required before detection, measurement changes, or current-session export. A calibrated session can be exported before any measurements are recorded. The ZIP format also supports importing older uncalibrated sessions. Calibration applies to all measurements for the current image. Loading a new image requires a new calibration. Imported sessions with a saved scale restore it automatically; sessions without one retain their measurements but require calibration before continuing.

Local saves belong to the current browser profile and site address. Private browsing, clearing site data, browser eviction, or storage limits can remove or prevent saves. Export ZIP backups for portability and long-term retention; no images are uploaded. Projects are limited to 100 images and 128 MiB (including expanded contents on import), with PNG files up to 128 MiB. Imported PNGs are checked against metadata and decoded before saving. Unsupported or malformed projects are rejected; imports receive new IDs rather than overwriting existing projects.

ZIP projects contain `project_manifest.json` and one `items/item_001/` directory per image, each with `metadata.json`, `measurements.csv`, and `image.png`. Set projects also contain a combined top-level `measurements.csv`. Ordinary archive, image, and text tools can recover these files without Mycrometer. ZIP downloads use the browser's normal download destination.

All CSV exports open a **Save As** dialog to choose a folder and filename in supported browsers, such as desktop Chrome and Edge, over HTTPS or localhost. The browser can remember the last export folder. Canceling the dialog does not download anything. On mobile and browsers without this capability, exports use the browser's normal download behavior; its download settings determine the destination.

Object detection uses local adaptive thresholding and contour bounds, with no roundness or aspect-ratio assumptions. It works best when objects contrast with their surroundings. Dark and bright foregrounds are tested automatically. **Detection settings** provides a contrast-sensitivity slider and minimum/maximum width and height inputs in a selected physical unit. Defaults are 8/12 sensitivity, a minimum side of sqrt(50) source pixels, and a maximum side of 10% of the image width (at least twice the minimum side for small images). These pixel dimensions are converted through the calibration and rounded up to whole numbers in the displayed unit. Unit conversions and manually entered dimensions are also rounded up (manual entries when leaving the field), so changing units can increase the resulting pixel-area limits, especially with coarse units. Width times height is converted to source-image pixels squared, with a hard minimum of 50 px² to exclude noise; the maximum must be at least the effective minimum. Area limits apply to detected contour area, not the rotated box's area. The best target is chosen before applying size limits, so a rejected object is not replaced by a larger contrast halo. Settings affect future clicks only; existing measurements, manual boxes, and editor resizing are unchanged. Touching objects may merge into one box; review the active draft and use a manual box for missed objects.

Click detection prefers a contour containing the click and tolerates clicks up to four source-image pixels outside a contour. It returns at most one box and does not substitute a distant object when none matches. Large objects trigger an expanding search crop; objects cut off by the image boundary can produce partial boxes. The first detection loads OpenCV locally in the browser and may take longer than subsequent clicks. Detection quality depends on local contrast; always review the box before accepting it.

**Detection preview** opens a phone-friendly dialog with an image overview for choosing a sample area and separate original, dark-object, and light-object views. The preview uses the same adaptive threshold and morphology as the initial click-detection crop, around the last clicked point (or image centre). Moving **Detection sensitivity** right includes weaker contrast; moving it left keeps stronger contrast only. White pixels in the masks are foreground candidates, not guaranteed object selections: size filters and the expanding search still apply during actual detection. The slider updates future detections immediately without changing saved measurements. The dialog supports touch, keyboard area selection, Escape, and focus containment, and can be opened before calibration.

The sample-area image supports zoom buttons, mouse-wheel zoom, drag-to-pan, and two-finger pinch zoom on touchscreens. Tap or click without dragging to select an area; the selection remains in source-image pixels regardless of display zoom. **Fit image** resets the overview. Zooming and panning do not change the detection crop size or accepted measurements.

The preview's **Noise reduction** selector offers **Current smoothing** (the original 3 x 3 Gaussian filter), **Median** (3 x 3), and **Edge-preserving** (a bilateral filter). The selected filter updates both dark/light masks and future detections; the original image and accepted measurements are unchanged. These are alternative filters, not cumulative steps. Filtering can shift detected boundaries, so review each proposed measurement. Filter and recovery settings last for the current page session.

**Recover nearby objects**, enabled by default in the preview, allows a missed click to select a size-valid contour between 4 and 16 source-image pixels from the point. Direct-click selection is preferred. Nearby alternatives are ranked by distance, and recovery declines when the next candidate is less than 4 pixels farther away. A recovered proposal is labelled **Nearby object selected** in the editor and still requires explicit acceptance. Disable recovery to retain the original four-pixel click tolerance. Size limits are never bypassed, and a rejected direct target is not replaced by a larger enclosing halo.

In the overview, length and width use the major and minor box axes. Q is length divided by width. Mean ± SD uses sample standard deviation (`n - 1`); for `N = 1`, SD is shown as not applicable. D1–D9 is the linearly interpolated 10th–90th percentile range, with observed extremes outside that range in parentheses. N counts the box measurements used in the spore summary.

The mycological summary above the image displays D1–D9 dimensional ranges, with observed extremes outside that range in parentheses, followed by Q range, N, Me (median length × median width), and Qe (median Q).

## Multi-Image Sets

1. Load and calibrate an image, then record its measurements as usual.
2. Choose **Add image to set** in the Measurement set section before replacing or unloading the image.
3. Load the next image, calibrate it independently, record its measurements, and choose **Add image to set** again.
4. Review the set-wide length, width, Q, and mycological summary. **Set unit** converts all physical dimensions to a common unit using each image's saved calibration. Statistics pool individual boxes, not image averages; N counts boxes across the saved images.
5. Choose **Export set CSV** to export every measurement with its source image name and image ID. Distance measurements are included in the CSV and total count, but not the box size/Q summary.

Adding an image saves a snapshot of its measurements and calibration. After editing or recalibrating the current image, choose **Update image in set** to replace that snapshot without duplicating it. Loading or unloading an image, clearing its measurements, or importing another session does not change saved snapshots. Remove individual images from the set or choose **Clear set** to discard the set explicitly. Reopening an image as a new load creates a separate set entry, even if the filename is the same.

Sets and their image snapshots save automatically in IndexedDB. Give a set a name, use **New set** to begin another without deleting the previous set, and reopen saved sets from the **Sets** tab in **Saved projects**. Click an image within a set to reopen its saved snapshot. **Export set** bundles every snapshot with its PNG image, calibration, editable geometry, and combined CSV; **Import project** restores the whole set. **Export set CSV** still provides spreadsheet values only. **Clear set** deletes the active saved set but keeps individual sessions. Deleting a session does not remove its snapshot from a saved set.

## Development

For the source-module map, data flow, coordinate rules, and persistence model, see [Architecture and Software Design](ARCHITECTURE.md).

UI translations live in `src/locales/`. To add a language, copy `en.json` to a new file named with its language code, translate its messages and status templates, and set its native `languageName`. Locale JSON files are discovered automatically and bundled for offline use; missing entries fall back to English.

DM Sans and DM Mono are bundled locally under the SIL Open Font License 1.1; see `public/font-licenses.txt` for the copyright notices and license.

Install dependencies and run the local development server:

```sh
npm install
npm run dev
```

Create and preview a production build:

```sh
npm run build
npm run preview
```

Run the geometry, export, image-processing, and IndexedDB/ZIP round-trip tests with `npm test`.

## Install on a phone

Publish the production build (`npm run build`) to a URL served over HTTPS. The development server is not installable as a standalone offline PWA because the service worker is registered only in production builds.

On Android, open the HTTPS URL in Chrome and choose **Install app** or **Add to Home screen** from the browser menu. On iPhone, open it in Safari, tap **Share**, then choose **Add to Home Screen**. Open the installed app once while online so its app shell and assets can be cached for offline use.
