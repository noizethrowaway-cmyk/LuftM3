# LuftM PWA package for GitHub Pages

This is a **Progressive Web App (PWA) web package**, not an Android project. It is prepared for static hosting on GitHub Pages. It contains the LuftM V2 cost-calculator web component, a demonstration page, a web app manifest, a service worker, install icons and a GitHub Actions deployment workflow.

## What's included

- `site/index.html` — browser app shell and calculator preview.
- `site/luftm-cost-calculator.js` — reusable calculator custom element.
- `site/manifest.webmanifest` — PWA name, icon, scope and install display mode.
- `site/sw.js` — service worker for the static app shell and offline fallback behaviour.
- `site/icons/` — 192px, 512px and maskable 512px PNG icons.
- `.github/workflows/deploy-pages.yml` — deploys the `site/` directory to GitHub Pages.

The demo page intentionally uses example weather readings and labels itself as an integration preview. **Do not present those example readings as live conditions.** Connect the component to your existing V2 weather feed and indoor readings before treating it as the live LuftM planner.

## Deploy this package as a standalone GitHub Pages site

1. Extract this package into a GitHub repository, keeping the `.github` and `site` directories.
2. Commit and push to the repository's `main` branch.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, select **GitHub Actions** as the source.
5. The workflow deploys the contents of `site/`. Open the Pages URL shown in the workflow deployment summary.

The paths in the HTML, manifest and service worker are relative, and the manifest scope is `./`, so the package supports both a user/organisation site and a project site under `/repository-name/`.

## Add the PWA assets to an existing LuftM V2 website

If your current V2 website already has its own `index.html` and deployment workflow, **do not replace them with this demo page or blindly add a second deployment workflow**. Instead:

1. Copy `site/luftm-cost-calculator.js` into your existing static assets directory.
2. Copy `site/manifest.webmanifest` and `site/sw.js` into the directory served at the site's root, adjusting relative paths if you put them elsewhere.
3. Copy `site/icons/` into the same served root.
4. Add this to the existing page's `<head>`:

   ```html
   <link rel="manifest" href="./manifest.webmanifest">
   <meta name="theme-color" content="#f4f7f6">
   <link rel="apple-touch-icon" href="./icons/icon-192.png">
   ```

5. Place the custom element where the calculator belongs:

   ```html
   <luftm-cost-calculator></luftm-cost-calculator>
   <script type="module" src="./luftm-cost-calculator.js"></script>
   ```

6. Register the service worker once in the existing application entry point:

   ```js
   if ('serviceWorker' in navigator && location.protocol === 'https:') {
     window.addEventListener('load', () => {
       navigator.serviceWorker.register('./sw.js', { scope: './' });
     });
   }
   ```

   Use a path relative to the actual deployed page. Do not register two competing service workers for the same scope. If V2 already has a service worker, merge the PWA caching logic into the existing one instead.

## Connect to live V2 data

After the component has loaded, pass through your existing live values:

```js
const calculator = document.querySelector('luftm-cost-calculator');

calculator.setConditions({
  outdoorTempC: weather.current.temperature_2m,
  outdoorRh: weather.current.relative_humidity_2m,
  outdoorDewPointC: weather.current.dew_point_2m,
  indoorTempC: indoor.temperatureC,
  indoorRh: indoor.relativeHumidity,
  coldSurfaceTempC: indoor.coldestSurfaceTemperatureC ?? null,
  weatherUpdatedAt: weather.current.time,
  source: 'live',
});
```

Change the property names to match your V2 data model. Call `setConditions()` again when the selected forecast hour or indoor readings change. The cost component does not fetch weather independently; it reuses data supplied by V2.

## Offline behaviour

The service worker caches the app shell so that the previously loaded interface can open offline. Weather forecasts still require an internet connection. Do not use cached weather as if it were current: the main app should keep displaying the timestamp and stale-data warning for offline or old forecast values.

When changing the app shell or calculator script, bump `CACHE_VERSION` at the top of `site/sw.js` so installed clients receive the updated cached files.

## Important calculation scope

The calculator estimates sensible heat required to warm the assumed replacement air only. It does not measure actual air replacement, infer air exchange from window-open duration, or estimate all heat lost by the building fabric, furnishings or evaporation. Standing charges are excluded. All user tariff and room assumptions are editable.

The included Ofgem reference rates are date-effective defaults; users should check their own regional and payment-method tariff. Source: <https://www.ofgem.gov.uk/your-energy-supply/your-energy-bill/energy-price-cap-unit-rates-and-standing-charges>.
