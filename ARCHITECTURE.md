# Architecture and Software Design

This document explains how Mycrometer is organized and how its main workflows move through the code. It is intended for developers who may not work with TypeScript every day.

## System At A Glance

Mycrometer is a client-side React application. It runs in the user's browser; images, measurements, calibration, and CSV processing are not sent to an application server.

```text
Browser
  index.html
    src/main.tsx                 Starts React and registers the production service worker
      src/App.tsx                Owns the workspace, interactions, and current session state
        src/objectDetection.ts   Finds image contours using lazily loaded OpenCV.js
        src/boxGeometry.ts       Calculates and edits rotated measurement boxes
        src/measurementCsv.ts    Defines measurement data and reads/writes CSV
        src/locales/*.json       UI messages and status translations per language
        src/style.css            Layout and visual styling
  public/sw.js                   Caches the application shell and same-origin assets
```

`App.tsx` also contains the box-editing dialog and the summary calculations. The project is small enough that the workspace and its interaction rules currently live together rather than being split into many UI components.

## Source Map

| File | Responsibility |
| --- | --- |
| `index.html` | Browser document, app mount point, and PWA metadata links. |
| `src/main.tsx` | Loads fonts and CSS, mounts the React app, and registers the service worker only in production. |
| `src/App.tsx` | Main screen and interaction controller: loading images, calibration, drawing, detection, editing, summaries, and downloads. |
| `src/boxGeometry.ts` | Pure geometry operations for oriented boxes, such as corners, resizing, rotating, hit testing, and keeping a box within the image. It does not depend on the UI. |
| `src/objectDetection.ts` | Converts an image or image region to pixels, runs OpenCV thresholding and contour detection, and maps detected boxes back to source-image coordinates. |
| `src/measurementCsv.ts` | Measurement/session data definitions, unit conversion for sets, CSV export, and validation/parsing of imported session CSV files. |
| `src/locales/*.json` | UI translations. Each locale file is named with its language code and contains a native `languageName`, `messages`, `statuses`, and `statusTemplates`. Vite discovers these files automatically. |
| `src/style.css` | Application and responsive layout styling. |
| `src/utif.d.ts` | TypeScript declaration that lets the project use the UTIF library. It describes the library to the compiler; it is not the TIFF decoder itself. |
| `public/sw.js` | Production offline behavior: caches the shell and successful same-origin GET responses, then serves cached files when offline. |
| `vite.config.ts` | Vite build configuration, including the deployed base path. |

## Plain-Language TypeScript Notes

- TypeScript is JavaScript with extra descriptions of expected data. For example, `Measurement` says what fields a distance or box measurement has. These descriptions help catch mistakes while building; they do not create a server or a database.
- A function is a named operation. The geometry and CSV modules export functions so `App.tsx` can use them without owning their calculations.
- React state is the app's live, in-memory workspace. Updating state asks React to redraw the affected UI. A `ref` holds a value or browser element that needs to survive redraws but should not itself trigger one, such as the canvas or an active pointer gesture.
- An `async` function can wait for browser work such as reading a file or loading OpenCV. The page remains responsible for deciding what to show when that work succeeds or fails.
- The HTML canvas is drawn directly by browser canvas APIs. It displays the image and measurement overlays; measurement geometry is not stored as screen pixels.

## Interface Languages

The interface language is held in React state and remembered in local storage. Locale files under `src/locales/` are discovered with an eager Vite glob, so they are included in the application bundle and available offline; no translation service or runtime download is used. The selected language code also sets the document's `lang` attribute.

Each locale JSON file has a native `languageName` for the language selector, `messages` for interface copy, `statuses` for fixed workflow and error messages, and `statusTemplates` for messages containing values such as image names, measurement counts, or CSV row numbers. English is the fallback when a message or status translation is missing. English and Dutch currently use matching keys in all three sections.

To add a language, copy `src/locales/en.json` to a new `<language-code>.json` file, translate the values, and set `languageName` to the language's native name. The glob adds the new file to the selector and build automatically. Keep the keys intact and the section structure aligned with `en.json`; missing translations still display English.

## Data And Coordinate Rules

The main data shapes are declared in `measurementCsv.ts`:

- A `Measurement` is either a line distance (`start`, `end`, pixel length) or a box (`rect` with center, width, height, and angle).
- A `Calibration` is a pixels-per-unit scale plus a unit (`µm`, `mm`, or `nm`). Physical values are derived from pixel geometry and this scale.
- A `MeasurementSession` combines image name and dimensions, optional calibration, and measurements. A measurement set is a collection of these snapshots with a calibration for each image.

The source image's pixel coordinate system is the stable reference. Zoom, pan, canvas size, and device-pixel ratio affect only how the image is displayed. Pointer positions are translated from the display back into source-image pixels before they become measurement data. Detection can downscale a temporary processing copy, but translates its results back to source pixels before returning them. This separation is essential: changing the view must not change a measurement.

Boxes are rotated rectangles, not guaranteed object segmentations. Detection proposes a box; the user reviews and edits it before accepting it. `boxGeometry.ts` is the shared place for box operations so the display editor and saved measurements use the same geometry rules.

## Main Workflows

### Open, Calibrate, Measure

1. `App.tsx` validates and opens a selected image. Ordinary browser-supported images use a local object URL. TIFF is decoded in the browser with UTIF, using its first page, then converted to a canvas-compatible PNG URL.
2. The image is checked for valid dimensions and the 40-megapixel limit. A new image starts with no measurements or calibration.
3. The user marks two points on a known scale bar and enters its real length and unit. Calibration is calculated as the distance between those points in source pixels divided by the known length.
4. The user can click an object for a one-object detection proposal or drag a manual rectangle. A proposal remains a draft until accepted in the box editor. Saved measurements are kept in React state.
5. Summaries are calculated from saved box measurements. Distances are listed and exported but are not included in the box length/width/Q summary.

### Detect An Object

`App.tsx` calls `detectClickedObject` in `objectDetection.ts`. That function loads OpenCV.js only when needed, checks dark and bright foreground thresholding, and searches a crop around the click. If the target is clipped by the temporary crop, the search crop expands. The best matching candidate is returned as one proposal or no result; it is never silently saved as a measurement.

The detector uses adaptive thresholding and contour area. Accepted contours are enclosed in boxes aligned to the principal axes of their filled silhouette, calculated from OpenCV contour moments and a single pass projecting contour vertices. Nearly round contours (normalized second-moment anisotropy below 0.1) retain a minimum-area rotated rectangle because their principal orientation is unreliable. Alignment adds no image-sized buffers and runs only after area, crop, and click filtering. It does not assume objects are round or have a particular aspect ratio. Its results are candidates and must be reviewed. Detection settings and source-pixel area limits are applied to future detection actions.

The detection preview dialog shares the initial click crop and processing pipeline with the detector. Noise reduction selects Gaussian (default), median, or bilateral filtering on the temporary grayscale image; it does not modify the source image. `createDetectionPreview` returns the original crop and dark/bright masks. Filter selection and the optional nearby-recovery toggle are held in `App.tsx` for the current page session. Recovery only considers size-valid contours within 16 source-image pixels, ranks them by distance, rejects near ties, and labels recovered proposals in the box editor. The original direct-click path retains its four-pixel tolerance and priority. Preview updates are debounced and stale asynchronous results are ignored.

### Edit And Summarize

The image canvas is redrawn from current state. It draws the loaded image, saved measurements, and temporary interaction drafts. The user can select a saved box and resize or rotate it; the geometry helpers keep those operations in image coordinates and constrain the result to the image. Accepting a new draft adds it to the list; canceling a draft leaves saved measurements untouched.

The current image summary is calculated in `App.tsx` from box length, width, and Q (length divided by width). A measurement set stores per-image snapshots in memory and converts their physical values into the selected common unit before computing pooled summaries.

### CSV And Persistence

`measurementCsv.ts` creates three CSV forms:

- Measurement CSV: values for the current image, without restorable geometry.
- Session CSV: values plus calibration, image dimensions, and geometry needed to restore measurements.
- Set CSV: measurements from saved images with image IDs and names; it is a combined values export, not a restorable multi-image session.

Session import validates the header, row values, units, image dimensions, and configured size limits before reconstructing measurements. The app matches the session to an image by name and dimensions; the image itself is selected separately because browsers do not let a web page reopen a user's local file by its path.

There is no automatic persistent measurement database. Current measurements and measurement-set snapshots live in memory and are lost on refresh or when the page closes. Export session CSVs to retain editable geometry. The service worker caches application files for offline use, not user images or measurement data.

## Development And Safe Change Points

Install dependencies with `npm install`, run the app with `npm run dev`, and verify changes with `npm run build`. The build runs TypeScript checks before producing the Vite bundle.

When changing behavior, keep these ownership rules in mind:

- Change box math in `boxGeometry.ts`, then make the UI call those helpers rather than duplicating coordinate math.
- Change detection behavior in `objectDetection.ts`; preserve source-pixel coordinates and keep detection proposals separate from accepted measurements.
- Change measurement formats, import validation, or unit conversions in `measurementCsv.ts` so imports and exports share one data model.
- Change workflow, browser events, drawing, summaries, or visible controls in `App.tsx`.
- Keep image processing and measurement data local to the browser. Do not introduce an image upload service.

For offline behavior, test a production build with `npm run build` and `npm run preview` after first loading the app online. The development server does not register the service worker.