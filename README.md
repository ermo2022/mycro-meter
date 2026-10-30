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
- Export a session CSV (calibration, image name/size, and box geometry) and import it later to redraw the measurements on the same image.
- Combine calibrated measurements from multiple images in a measurement set, with pooled statistics, unit conversion, and a combined CSV export.
- Install as a PWA and use the app shell offline after the first online visit.
- Switch the interface between English and Dutch; the selected language is remembered on this device.

## Use

1. Select **Open image** and choose a microscope image. Use **Replace image** to switch files or **Unload** to clear the current image, calibration, and measurements.
2. The calibration tool is selected automatically. Click both ends of a known scale bar; pan and zoom remain available to reach it.
3. Enter its real-world length and unit, then choose **Set scale**. Recalibration preserves measurements and updates their physical values from the original pixel geometry.
4. In **Measure object** mode, click an object to detect a single box around it. The detector searches near the click, tries dark and bright foregrounds automatically, and expands its temporary crop when needed. There are no persistent detection areas or candidate lists. Drag instead of clicking to draw a manual box.
5. Refine the initial box's edges or corners and rotate it with the round handle, then choose **Accept dimensions**. The box is only a draft until accepted: **Cancel**, Escape, or closing the editor removes it without adding a measurement. After acceptance, measure mode stays active for the next object. Use the select tool to edit a saved box on the image, or click a measurement in the list. Canceling an existing measurement edit preserves the saved measurement. Use the row's swap control to exchange length and width (the summary, Q, and exports follow the swap). Clear measurements explicitly when finished, or load a new image to reset the workspace.
6. Export the measurements from the analysis panel when ready. **Export CSV** writes only length/width values; **Export session** also stores calibration and geometry. Use **Import session** and select the session CSV together with its image (or pick the image when prompted) to restore the measurements.

Calibration is required before detection, measurement changes, or export. Calibration applies to all measurements for the current image. Loading a new image requires a new calibration. Imported sessions with a saved scale restore it automatically; sessions without one retain their measurements but require calibration before continuing.

All CSV exports open a **Save As** dialog to choose a folder and filename in supported browsers, such as desktop Chrome and Edge, over HTTPS or localhost. The browser can remember the last export folder. Canceling the dialog does not download anything. On mobile and browsers without this capability, exports use the browser's normal download behavior; its download settings determine the destination.

Object detection uses local adaptive thresholding and contour bounds, with no roundness or aspect-ratio assumptions. It works best when objects contrast with their surroundings. Dark and bright foregrounds are tested automatically. **Detection settings** provides a contrast-sensitivity slider and minimum/maximum object-area inputs. Defaults are 8/12 sensitivity and 25–1,000,000 px², allowing a broad range of object sizes. Area limits apply to detected contour area in original source-image pixels squared, not the rotated box's area or calibrated physical units. The best target is chosen before applying size limits, so a rejected object is not replaced by a larger contrast halo. The minimum must be at least 1 px² and the maximum must be at least the minimum. Settings affect future clicks only; existing measurements, manual boxes, and editor resizing are unchanged. Touching objects may merge into one box; review the active draft and use a manual box for missed objects.

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

Sets stay in memory for the current browser session and are lost on refresh or closing the page. Export before leaving. The combined CSV contains measurement values, not a restorable multi-image session; use individual **Export session** files to retain editable geometry for each image. Current-image exports still require calibration, but saved set values can be exported while the next image awaits calibration.

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

## Install on a phone

Publish the production build (`npm run build`) to a URL served over HTTPS. The development server is not installable as a standalone offline PWA because the service worker is registered only in production builds.

On Android, open the HTTPS URL in Chrome and choose **Install app** or **Add to Home screen** from the browser menu. On iPhone, open it in Safari, tap **Share**, then choose **Add to Home Screen**. Open the installed app once while online so its app shell and assets can be cached for offline use.
