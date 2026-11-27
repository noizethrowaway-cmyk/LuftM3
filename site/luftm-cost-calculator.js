/*
 * LuftM V2 — ventilation reheating cost calculator
 * Framework-independent custom element for static hosting (including GitHub Pages).
 *
 * Add to your page:
 *   <script type="module" src="./luftm-cost-calculator.js"></script>
 *   <luftm-cost-calculator></luftm-cost-calculator>
 *
 * Feed live values from the existing V2 app:
 *   document.querySelector('luftm-cost-calculator').setConditions({
 *     outdoorTempC: 5,
 *     outdoorRh: 90,
 *     outdoorDewPointC: 3.5,
 *     indoorTempC: 20,
 *     indoorRh: 65,
 *     coldSurfaceTempC: 12 // optional
 *   });
 *
 * Important: this estimates sensible heat needed to warm the assumed replacement
 * air only. It does not estimate total building heat loss or infer air replacement
 * from how long a window is open.
 */

const LUFTM_STORAGE_KEY = 'luftm-v2-energy-settings-v1';
const LUFTM_TARIFF_PERIODS = [
  {
    label: 'Ofgem average Direct Debit reference · 1 Oct–31 Dec 2026',
    start: '2026-10-01', end: '2026-12-31', electricityP: 26.32, gasP: 7.97,
  },
  {
    label: 'Ofgem average Direct Debit reference · 1 Jan–31 Mar 2027',
    start: '2027-01-01', end: '2027-03-31', electricityP: 32.69, gasP: 10.96,
  },
];

const LUFTM_ROOM_PRESETS = {
  'room-2x2': { label: 'Small room · 2m × 2m (4m²)', area: 4 },
  'room-3x2': { label: 'Room · 3m × 2m (6m²)', area: 6 },
  'room-3x3': { label: 'Room · 3m × 3m (9m²)', area: 9 },
  'room-4x3': { label: 'Room · 4m × 3m (12m²)', area: 12 },
  'home-81': { label: 'Whole home · 81m² (example 3-bed terrace)', area: 81 },
  'home-90': { label: 'Whole home · 90m²', area: 90 },
  'home-100': { label: 'Whole home · 100m²', area: 100 },
  custom: { label: 'Custom floor area', area: 20 },
};

function luftmNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function luftmClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function luftmRound(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function luftmGetReferenceTariff(date = new Date()) {
  // Use local calendar dates because these are UK tariff periods, not UTC instants.
  const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const match = LUFTM_TARIFF_PERIODS.find(period => localDate >= period.start && localDate <= period.end);
  if (match) return { ...match, current: true };

  // Retain the most recently published reference as a fallback, but flag it for review.
  const latest = LUFTM_TARIFF_PERIODS[LUFTM_TARIFF_PERIODS.length - 1];
  return { ...latest, current: false, label: `Last configured Ofgem reference · ended ${latest.end} · check for newer rates` };
}

function luftmLoadSettings() {
  const defaults = {
    electricityP: null,
    gasP: null,
    tariffMode: 'reference',
    heatingSystem: 'gas',
    boilerEfficiency: 0.90,
    heatPumpCop: 3.0,
    customFactor: 1.0,
    roomPreset: 'home-81',
    customArea: 81,
    ceilingHeight: 2.4,
    replacementPercent: 25,
    customReplacementPercent: 25,
    indoorTargetC: 20,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(LUFTM_STORAGE_KEY) || '{}');
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

function luftmSaveSettings(settings) {
  try {
    localStorage.setItem(LUFTM_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

class LuftMCostCalculator extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.settings = luftmLoadSettings();
    this.conditions = {
      outdoorTempC: 5,
      outdoorRh: 90,
      outdoorDewPointC: 3.5,
      indoorTempC: 20,
      indoorRh: 65,
      coldSurfaceTempC: null,
      weatherUpdatedAt: null,
      source: 'example',
    };
    this.hasCalculated = false;
    this.lastResult = null;
    this._bound = false;
  }

  connectedCallback() {
    if (!this.shadowRoot.innerHTML) this.render();
    this.applyConditionsToFields();
    this.updateSettingsFields();
    this.updateLiveSummary();
  }

  /** Update assumptions from your existing V2 weather and indoor-condition state. */
  setConditions(values = {}) {
    const source = values.source || 'live';
    const allowed = [
      'outdoorTempC', 'outdoorRh', 'outdoorDewPointC', 'indoorTempC',
      'indoorRh', 'coldSurfaceTempC', 'weatherUpdatedAt',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined) {
        this.conditions[key] = values[key] === null || values[key] === '' ? null : luftmNumber(values[key], null);
      }
    }
    this.conditions.source = source;
    if (this.isConnected) {
      const sourceWarning = this.$('#source-warning');
      sourceWarning.hidden = source !== 'demo' && source !== 'example';
      sourceWarning.textContent = 'Example readings are being used for this preview. Connect the real LuftM weather and indoor-condition data before publishing.';
      this.applyConditionsToFields();
      this.updateLiveSummary();
      this.markCalculationStale();
    }
  }

  /** Optional method for integrating saved V2 indoor readings separately. */
  setIndoorConditions({ temperatureC, relativeHumidity, coldSurfaceTempC } = {}) {
    this.setConditions({
      indoorTempC: temperatureC,
      indoorRh: relativeHumidity,
      coldSurfaceTempC,
    });
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; color:var(--luftm-text, #202a35); font:inherit; }
        * { box-sizing:border-box; }
        .wrap { display:grid; gap:14px; }
        details.panel { background:var(--luftm-card, #fff); border:1px solid var(--luftm-border, #dce3e9); border-radius:16px; overflow:hidden; }
        summary { list-style:none; cursor:pointer; }
        summary::-webkit-details-marker { display:none; }
        .summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px; }
        .summary:hover { background:var(--luftm-hover, #f7f9fb); }
        .sum-copy { min-width:0; }
        .eyebrow { display:block; color:var(--luftm-muted, #657384); font-size:.75rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; margin-bottom:4px; }
        .sum-title { display:block; font-size:1rem; font-weight:750; line-height:1.35; }
        .sum-sub { display:block; color:var(--luftm-muted, #657384); font-size:.84rem; margin-top:4px; }
        .chevron { flex:0 0 auto; color:var(--luftm-muted, #657384); font-size:1.25rem; transition:transform .15s ease; }
        details[open] > summary .chevron { transform:rotate(180deg); }
        .content { padding:0 16px 16px; display:grid; gap:14px; }
        .intro { color:var(--luftm-muted, #657384); font-size:.9rem; line-height:1.5; margin:0; }
        .preview { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
        .metric { background:var(--luftm-soft, #f3f6f8); border-radius:12px; padding:11px; min-width:0; }
        .metric-label { display:block; color:var(--luftm-muted, #657384); font-size:.73rem; line-height:1.35; }
        .metric-value { display:block; font-size:1.12rem; font-weight:750; margin-top:4px; overflow-wrap:anywhere; }
        .subpanel { border:1px solid var(--luftm-border, #dce3e9); border-radius:12px; overflow:hidden; }
        .subpanel > summary { padding:13px 14px; display:flex; justify-content:space-between; align-items:center; gap:10px; font-weight:700; }
        .subpanel > .content { padding:0 14px 14px; }
        .section-title { font-size:.82rem; font-weight:800; letter-spacing:.045em; text-transform:uppercase; margin:2px 0 0; }
        .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:11px; }
        .field { display:grid; gap:5px; min-width:0; }
        .field.full { grid-column:1/-1; }
        label { font-size:.82rem; font-weight:650; }
        input, select { width:100%; min-height:42px; border:1px solid var(--luftm-input-border, #cbd5df); border-radius:9px; padding:9px 10px; background:var(--luftm-input-bg, #fff); color:inherit; font:inherit; font-size:.92rem; }
        input:focus, select:focus, button:focus-visible, summary:focus-visible { outline:3px solid var(--luftm-focus, #7aa7e8); outline-offset:2px; }
        input:disabled { opacity:.65; }
        .hint { color:var(--luftm-muted, #657384); font-size:.75rem; line-height:1.4; }
        .checkrow { display:flex; align-items:flex-start; gap:9px; font-size:.84rem; line-height:1.4; }
        .checkrow input { width:18px; min-height:18px; margin:1px 0 0; flex:0 0 auto; }
        .actions { display:flex; flex-wrap:wrap; gap:8px; }
        button { border:0; border-radius:10px; padding:11px 14px; font:inherit; font-size:.88rem; font-weight:750; cursor:pointer; }
        button.primary { background:var(--luftm-accent, #245d50); color:#fff; }
        button.secondary { background:var(--luftm-soft, #f3f6f8); color:inherit; border:1px solid var(--luftm-border, #dce3e9); }
        button:disabled { opacity:.45; cursor:not-allowed; }
        .result { border:1px solid var(--luftm-border, #dce3e9); background:var(--luftm-soft, #f3f6f8); border-radius:13px; padding:14px; display:grid; gap:9px; }
        .result.hidden { display:none; }
        .result-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
        .result-cost { font-size:1.8rem; line-height:1.1; font-weight:850; letter-spacing:-.03em; }
        .result-caption { color:var(--luftm-muted, #657384); font-size:.78rem; margin-top:4px; }
        .rows { display:grid; gap:7px; }
        .row { display:flex; justify-content:space-between; gap:12px; font-size:.84rem; border-top:1px solid var(--luftm-border, #dce3e9); padding-top:7px; }
        .row span:first-child { color:var(--luftm-muted, #657384); }
        .row strong { text-align:right; }
        .notice { padding:10px 11px; border-radius:9px; background:var(--luftm-note-bg, #eef4f7); color:var(--luftm-note-text, #344958); font-size:.79rem; line-height:1.45; }
        .warning { background:#fff4df; color:#684700; }
        .source { font-size:.74rem; color:var(--luftm-muted, #657384); line-height:1.45; }
        a { color:var(--luftm-link, #245d50); }
        .settings-status { color:var(--luftm-muted, #657384); font-size:.78rem; }
        @media (max-width:560px) { .grid { grid-template-columns:1fr; } .preview { grid-template-columns:repeat(3,minmax(0,1fr)); } .metric { padding:9px; } .metric-value { font-size:1rem; } .summary { padding:14px; } .content { padding:0 14px 14px; } }
      </style>

      <div class="wrap">
        <details class="panel" id="cost-panel">
          <summary class="summary">
            <span class="sum-copy">
              <span class="eyebrow">Ventilation cost estimate</span>
              <span class="sum-title">Air out. Warm back up. What's the cost?</span>
              <span class="sum-sub" id="summary-line">Check the estimated cost of reheating replacement air</span>
            </span>
            <span class="chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="content">
            <p class="intro">Estimate the extra energy needed to warm the air assumed to have been replaced during a short airing. This is an estimate for the air itself, not the whole building.</p>
            <div class="notice warning" id="source-warning">Example readings are shown until the existing LuftM weather and indoor-condition data are connected. Do not treat these example values as live weather.</div>
            <div class="preview" aria-label="Current ventilation assumptions">
              <div class="metric"><span class="metric-label">Outside</span><strong class="metric-value" id="preview-outside">5°C</strong></div>
              <div class="metric"><span class="metric-label">Indoor target</span><strong class="metric-value" id="preview-inside">20°C</strong></div>
              <div class="metric"><span class="metric-label">Room volume</span><strong class="metric-value" id="preview-volume">194.4m³</strong></div>
            </div>

            <details class="subpanel" id="assumptions-panel">
              <summary><span>Check or change the assumptions</span><span class="chevron" aria-hidden="true">⌄</span></summary>
              <div class="content">
                <h3 class="section-title">Weather and indoor conditions</h3>
                <div class="grid">
                  <div class="field"><label for="outside-temp">Outside temperature (°C)</label><input id="outside-temp" type="number" step="0.1" min="-50" max="60" value="5"></div>
                  <div class="field"><label for="outside-rh">Outside relative humidity (%)</label><input id="outside-rh" type="number" step="1" min="0" max="100" value="90"></div>
                  <div class="field"><label for="inside-temp">Current indoor temperature (°C)</label><input id="inside-temp" type="number" step="0.1" min="0" max="40" value="20"></div>
                  <div class="field"><label for="inside-rh">Indoor relative humidity (%)</label><input id="inside-rh" type="number" step="1" min="1" max="100" value="65"></div>
                  <div class="field"><label for="target-temp">Desired temperature after airing (°C)</label><input id="target-temp" type="number" step="0.1" min="0" max="40" value="20"></div>
                  <div class="field"><label for="surface-temp">Coldest measured surface (°C) · optional</label><input id="surface-temp" type="number" step="0.1" min="-30" max="50" placeholder="Not measured"></div>
                  <div class="field full"><span class="hint" id="dewpoint-line">Dew point comparison will appear here when values are available.</span></div>
                </div>

                <h3 class="section-title">Room size and air replacement</h3>
                <div class="grid">
                  <div class="field full"><label for="room-preset">Room or whole-home size</label><select id="room-preset">
                    <option value="room-2x2">Small room · 2m × 2m (4m²)</option>
                    <option value="room-3x2">Room · 3m × 2m (6m²)</option>
                    <option value="room-3x3">Room · 3m × 3m (9m²)</option>
                    <option value="room-4x3">Room · 4m × 3m (12m²)</option>
                    <option value="home-81">Whole home · 81m² (example 3-bed terrace)</option>
                    <option value="home-90">Whole home · 90m²</option>
                    <option value="home-100">Whole home · 100m²</option>
                    <option value="custom">Custom floor area</option>
                  </select></div>
                  <div class="field" id="custom-area-field"><label for="custom-area">Floor area (m²)</label><input id="custom-area" type="number" min="1" max="1000" step="0.1" value="81"></div>
                  <div class="field"><label for="ceiling-height">Average ceiling height (m)</label><input id="ceiling-height" type="number" min="1.5" max="6" step="0.05" value="2.4"></div>
                  <div class="field"><label for="replacement-select">Estimated air replaced</label><select id="replacement-select">
                    <option value="10">10% · Light exchange</option>
                    <option value="25" selected>25% · Moderate exchange</option>
                    <option value="50">50% · Strong exchange</option>
                    <option value="100">100% · Full-volume assumption</option>
                    <option value="custom">Custom percentage</option>
                  </select></div>
                  <div class="field" id="custom-replacement-field"><label for="custom-replacement">Custom replacement (%)</label><input id="custom-replacement" type="number" min="1" max="100" step="1" value="25"></div>
                  <div class="field full"><span class="hint" id="volume-line">Calculated room volume and estimated exchanged air will appear here.</span></div>
                </div>

                <h3 class="section-title">Heating system and energy prices</h3>
                <div class="grid">
                  <div class="field full"><label for="heating-system">How do you heat this space?</label><select id="heating-system">
                    <option value="gas">Gas boiler</option>
                    <option value="electric">Direct electric heating</option>
                    <option value="heatpump">Heat pump</option>
                    <option value="custom">Other / custom heat-output factor</option>
                  </select></div>
                  <div class="field" id="boiler-field"><label for="boiler-efficiency">Boiler seasonal efficiency (%)</label><input id="boiler-efficiency" type="number" min="50" max="110" step="1" value="90"></div>
                  <div class="field" id="cop-field"><label for="heat-pump-cop">Heat pump COP</label><input id="heat-pump-cop" type="number" min="1" max="8" step="0.1" value="3"></div>
                  <div class="field" id="custom-factor-field"><label for="custom-factor">Custom heat-output factor</label><input id="custom-factor" type="number" min="0.1" max="5" step="0.05" value="1"></div>
                  <div class="field"><label for="electricity-price">Electricity unit price (p/kWh)</label><input id="electricity-price" type="number" min="0" max="1000" step="0.01" value="26.32"></div>
                  <div class="field"><label for="gas-price">Gas unit price (p/kWh)</label><input id="gas-price" type="number" min="0" max="1000" step="0.01" value="7.97"></div>
                  <div class="field full"><span class="hint" id="tariff-label">Reference rates are indicative. Your own tariff may differ.</span></div>
                </div>

                <label class="checkrow"><input type="checkbox" id="confirmed"><span>I've checked these assumptions and want to calculate using these values.</span></label>
                <div class="actions">
                  <button class="primary" id="calculate-button" type="button" disabled>These assumptions are correct — calculate cost</button>
                  <button class="secondary" id="save-defaults-button" type="button">Save these values as my defaults</button>
                </div>
                <p class="settings-status" id="save-status" aria-live="polite"></p>
              </div>
            </details>

            <div class="result hidden" id="result" aria-live="polite">
              <div class="result-head">
                <div><span class="eyebrow">Estimated additional reheating cost</span><div class="result-cost" id="result-cost">£0.02</div><div class="result-caption" id="result-pence">2.16p for this airing scenario</div></div>
                <div class="metric"><span class="metric-label">Useful heat</span><strong class="metric-value" id="result-useful">0.24 kWh</strong></div>
              </div>
              <div class="rows">
                <div class="row"><span>Room volume</span><strong id="result-room-volume">194.4m³</strong></div>
                <div class="row"><span>Estimated air replaced</span><strong id="result-air-volume">48.6m³</strong></div>
                <div class="row"><span>Energy purchased</span><strong id="result-energy-input">0.27 kWh gas</strong></div>
                <div class="row"><span>Heating system</span><strong id="result-system">Gas boiler · 90%</strong></div>
                <div class="row"><span>Unit rate used</span><strong id="result-rate">7.97p/kWh</strong></div>
                <div class="row"><span>Temperature difference</span><strong id="result-delta">15°C</strong></div>
              </div>
              <div class="notice" id="result-explanation">This estimate covers replacement air only.</div>
              <div class="notice warning" id="surface-warning" hidden></div>
              <p class="source">Estimate only. Actual costs vary with ventilation, mixing, building fabric, furnishings, moisture sources and heating-system performance. The assumed replacement percentage is not measured from window-open time.</p>
            </div>
          </div>
        </details>

        <details class="panel" id="settings-panel">
          <summary class="summary">
            <span class="sum-copy"><span class="eyebrow">Saved preferences</span><span class="sum-title">Energy cost settings</span><span class="sum-sub">Set your usual tariff and heating system</span></span>
            <span class="chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="content">
            <p class="intro">These saved values pre-fill the one-off calculator. Only unit rates are included; daily standing charges are deliberately excluded.</p>
            <div class="grid">
              <div class="field"><label for="settings-electricity">Electricity (p/kWh)</label><input id="settings-electricity" type="number" min="0" max="1000" step="0.01"></div>
              <div class="field"><label for="settings-gas">Gas (p/kWh)</label><input id="settings-gas" type="number" min="0" max="1000" step="0.01"></div>
              <div class="field full"><label for="settings-heating">Usual heating system</label><select id="settings-heating"><option value="gas">Gas boiler</option><option value="electric">Direct electric heating</option><option value="heatpump">Heat pump</option><option value="custom">Other / custom</option></select></div>
              <div class="field"><label for="settings-efficiency">Boiler efficiency (%)</label><input id="settings-efficiency" type="number" min="50" max="110" step="1"></div>
              <div class="field"><label for="settings-cop">Heat pump COP</label><input id="settings-cop" type="number" min="1" max="8" step="0.1"></div>
            </div>
            <p class="settings-status" id="settings-tariff-status"></p>
            <div class="actions">
              <button class="primary" id="settings-save" type="button">Save energy settings</button>
              <button class="secondary" id="restore-tariff" type="button">Restore Ofgem reference rates</button>
            </div>
            <p class="source">Ofgem reference rates are average Direct Debit unit rates for Great Britain, not a guarantee of your tariff. They vary by region and payment method. Electricity and gas rates may be treated differently for VAT. Check your own bill for the actual price you pay. No standing charge is included.<br><a href="https://www.ofgem.gov.uk/your-energy-supply/your-energy-bill/energy-price-cap-unit-rates-and-standing-charges" target="_blank" rel="noopener noreferrer">Check Ofgem unit rates and standing charges</a>.</p>
          </div>
        </details>
      </div>
    `;

    if (!this._bound) {
      this.bindEvents();
      this._bound = true;
    }
  }

  $(selector) { return this.shadowRoot.querySelector(selector); }
  value(id) { return this.$(`#${id}`).value; }
  setValue(id, value) { if (value !== null && value !== undefined) this.$(`#${id}`).value = String(value); }

  applyConditionsToFields() {
    const mapping = {
      'outside-temp': this.conditions.outdoorTempC,
      'outside-rh': this.conditions.outdoorRh,
      'inside-temp': this.conditions.indoorTempC,
      'inside-rh': this.conditions.indoorRh,
      'surface-temp': this.conditions.coldSurfaceTempC,
    };
    for (const [id, value] of Object.entries(mapping)) {
      if (value !== null && value !== undefined) this.setValue(id, luftmRound(value, 1));
    }
  }

  updateSettingsFields() {
    const reference = luftmGetReferenceTariff();
    if (this.settings.tariffMode !== 'custom') {
      this.settings.electricityP = reference.electricityP;
      this.settings.gasP = reference.gasP;
      this.settings.tariffLabel = reference.label;
      // Do not write new automatic references over a user-entered custom tariff.
    }
    this.setValue('settings-electricity', this.settings.electricityP ?? reference.electricityP);
    this.setValue('settings-gas', this.settings.gasP ?? reference.gasP);
    this.setValue('settings-heating', this.settings.heatingSystem);
    this.setValue('settings-efficiency', Math.round(luftmNumber(this.settings.boilerEfficiency, 0.9) * 100));
    this.setValue('settings-cop', this.settings.heatPumpCop);
    this.setValue('room-preset', this.settings.roomPreset);
    this.setValue('custom-area', this.settings.customArea);
    this.setValue('ceiling-height', this.settings.ceilingHeight);
    this.setValue('replacement-select', String(this.settings.replacementPercent));
    this.setValue('custom-replacement', this.settings.customReplacementPercent);
    this.setValue('target-temp', this.settings.indoorTargetC);
    this.setValue('heating-system', this.settings.heatingSystem);
    this.setValue('boiler-efficiency', Math.round(luftmNumber(this.settings.boilerEfficiency, 0.9) * 100));
    this.setValue('heat-pump-cop', this.settings.heatPumpCop);
    this.setValue('custom-factor', this.settings.customFactor);
    this.setValue('electricity-price', this.settings.electricityP ?? reference.electricityP);
    this.setValue('gas-price', this.settings.gasP ?? reference.gasP);
    this.updateRoomFields();
    this.updateReplacementFields();
    this.updateHeatingFields();
    this.updateTariffLabel();
    this.updateSettingsTariffStatus();
  }

  bindEvents() {
    const ids = [
      'outside-temp', 'outside-rh', 'inside-temp', 'inside-rh', 'target-temp', 'surface-temp',
      'room-preset', 'custom-area', 'ceiling-height', 'replacement-select', 'custom-replacement',
      'heating-system', 'boiler-efficiency', 'heat-pump-cop', 'custom-factor', 'electricity-price', 'gas-price',
    ];
    for (const id of ids) {
      this.$(`#${id}`).addEventListener('input', () => {
        if (id === 'room-preset') this.updateRoomFields();
        if (id === 'replacement-select') this.updateReplacementFields();
        if (id === 'heating-system') this.updateHeatingFields();
        this.$('#confirmed').checked = false;
        this.$('#calculate-button').disabled = true;
        this.markCalculationStale();
        this.updateLiveSummary();
      });
      this.$(`#${id}`).addEventListener('change', () => {
        if (id === 'room-preset') this.updateRoomFields();
        if (id === 'replacement-select') this.updateReplacementFields();
        if (id === 'heating-system') this.updateHeatingFields();
        this.updateLiveSummary();
      });
    }
    this.$('#confirmed').addEventListener('change', event => {
      this.$('#calculate-button').disabled = !event.target.checked;
    });
    this.$('#calculate-button').addEventListener('click', () => this.calculate());
    this.$('#save-defaults-button').addEventListener('click', () => this.saveDefaultsFromCalculator());
    this.$('#settings-save').addEventListener('click', () => this.saveSettingsPanel());
    this.$('#restore-tariff').addEventListener('click', () => this.restoreReferenceTariffs());
  }

  updateRoomFields() {
    const isCustom = this.value('room-preset') === 'custom';
    this.$('#custom-area-field').hidden = !isCustom;
    const preset = LUFTM_ROOM_PRESETS[this.value('room-preset')];
    if (!isCustom && preset) this.setValue('custom-area', preset.area);
  }

  updateReplacementFields() {
    this.$('#custom-replacement-field').hidden = this.value('replacement-select') !== 'custom';
  }

  updateHeatingFields() {
    const system = this.value('heating-system');
    this.$('#boiler-field').hidden = system !== 'gas';
    this.$('#cop-field').hidden = system !== 'heatpump';
    this.$('#custom-factor-field').hidden = system !== 'custom';
  }

  updateTariffLabel() {
    const reference = luftmGetReferenceTariff();
    const custom = this.settings.tariffMode === 'custom';
    const text = custom
      ? 'Using your saved tariff. You can override it for this calculation.'
      : `${reference.label}. Rates are indicative; enter your own tariff if different.`;
    this.$('#tariff-label').textContent = text;
  }

  updateSettingsTariffStatus() {
    const reference = luftmGetReferenceTariff();
    const status = this.settings.tariffMode === 'custom'
      ? 'Your own saved unit rates are in use. Standing charges are excluded.'
      : `${reference.label}. ${reference.current ? 'Reference period is current today.' : 'This reference period has ended; check Ofgem for a newer published rate.'} Standing charges are excluded.`;
    this.$('#settings-tariff-status').textContent = status;
  }

  getAssumptions() {
    const roomPreset = this.value('room-preset');
    const area = roomPreset === 'custom'
      ? luftmNumber(this.value('custom-area'), NaN)
      : (LUFTM_ROOM_PRESETS[roomPreset]?.area ?? NaN);
    const ceiling = luftmNumber(this.value('ceiling-height'), NaN);
    const replacement = this.value('replacement-select') === 'custom'
      ? luftmNumber(this.value('custom-replacement'), NaN)
      : luftmNumber(this.value('replacement-select'), NaN);
    const heatingSystem = this.value('heating-system');
    const indoorTarget = luftmNumber(this.value('target-temp'), NaN);
    return {
      outdoorTemp: luftmNumber(this.value('outside-temp'), NaN),
      outdoorRh: luftmNumber(this.value('outside-rh'), NaN),
      indoorTemp: luftmNumber(this.value('inside-temp'), NaN),
      indoorRh: luftmNumber(this.value('inside-rh'), NaN),
      indoorTarget,
      surfaceTemp: this.value('surface-temp') === '' ? null : luftmNumber(this.value('surface-temp'), NaN),
      area,
      ceiling,
      roomVolume: area * ceiling,
      replacementPercent: replacement,
      replacementFraction: replacement / 100,
      heatingSystem,
      boilerEfficiency: luftmNumber(this.value('boiler-efficiency'), NaN) / 100,
      heatPumpCop: luftmNumber(this.value('heat-pump-cop'), NaN),
      customFactor: luftmNumber(this.value('custom-factor'), NaN),
      electricityP: luftmNumber(this.value('electricity-price'), NaN),
      gasP: luftmNumber(this.value('gas-price'), NaN),
      roomPreset,
    };
  }

  validate(a) {
    const checks = [
      [Number.isFinite(a.outdoorTemp) && a.outdoorTemp >= -50 && a.outdoorTemp <= 60, 'Enter an outside temperature between -50°C and 60°C.'],
      [Number.isFinite(a.outdoorRh) && a.outdoorRh >= 0 && a.outdoorRh <= 100, 'Outside relative humidity must be between 0% and 100%.'],
      [Number.isFinite(a.indoorTemp) && a.indoorTemp >= 0 && a.indoorTemp <= 40, 'Enter an indoor temperature between 0°C and 40°C.'],
      [Number.isFinite(a.indoorRh) && a.indoorRh > 0 && a.indoorRh <= 100, 'Indoor relative humidity must be greater than 0% and no more than 100%.'],
      [Number.isFinite(a.indoorTarget) && a.indoorTarget >= 0 && a.indoorTarget <= 40, 'Desired indoor temperature must be between 0°C and 40°C.'],
      [a.surfaceTemp === null || (Number.isFinite(a.surfaceTemp) && a.surfaceTemp >= -30 && a.surfaceTemp <= 50), 'Enter a valid measured surface temperature or leave it blank.'],
      [Number.isFinite(a.area) && a.area > 0 && a.area <= 1000, 'Floor area must be greater than 0 and no more than 1,000m².'],
      [Number.isFinite(a.ceiling) && a.ceiling >= 1.5 && a.ceiling <= 6, 'Ceiling height must be between 1.5m and 6m.'],
      [Number.isFinite(a.replacementPercent) && a.replacementPercent > 0 && a.replacementPercent <= 100, 'Air replacement must be greater than 0% and no more than 100%.'],
      [Number.isFinite(a.electricityP) && a.electricityP >= 0 && a.electricityP <= 1000, 'Enter a valid electricity unit price.'],
      [Number.isFinite(a.gasP) && a.gasP >= 0 && a.gasP <= 1000, 'Enter a valid gas unit price.'],
    ];
    if (a.heatingSystem === 'gas') checks.push([a.boilerEfficiency >= 0.5 && a.boilerEfficiency <= 1.1, 'Boiler efficiency must be between 50% and 110%.']);
    if (a.heatingSystem === 'heatpump') checks.push([a.heatPumpCop >= 1 && a.heatPumpCop <= 8, 'Heat pump COP must be between 1 and 8.']);
    if (a.heatingSystem === 'custom') checks.push([a.customFactor >= 0.1 && a.customFactor <= 5, 'Custom heat-output factor must be between 0.1 and 5.']);
    return checks.find(([valid]) => !valid)?.[1] || null;
  }

  dewPoint(tempC, rh) {
    if (!Number.isFinite(tempC) || !Number.isFinite(rh) || rh <= 0 || rh > 100) return null;
    const a = 17.62;
    const b = 243.12;
    const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
    return (b * gamma) / (a - gamma);
  }

  updateLiveSummary() {
    if (!this.shadowRoot.querySelector('#preview-outside')) return;
    const a = this.getAssumptions();
    const insideDp = this.dewPoint(a.indoorTemp, a.indoorRh);
    const outsideDp = this.conditions.outdoorDewPointC !== null && this.conditions.outdoorDewPointC !== undefined
      ? luftmNumber(this.conditions.outdoorDewPointC, null)
      : this.dewPoint(a.outdoorTemp, a.outdoorRh);
    this.$('#preview-outside').textContent = Number.isFinite(a.outdoorTemp) ? `${luftmRound(a.outdoorTemp, 1)}°C` : '—';
    this.$('#preview-inside').textContent = Number.isFinite(a.indoorTarget) ? `${luftmRound(a.indoorTarget, 1)}°C` : '—';
    this.$('#preview-volume').textContent = Number.isFinite(a.roomVolume) ? `${luftmRound(a.roomVolume, 1)}m³` : '—';
    if (Number.isFinite(insideDp) && Number.isFinite(outsideDp)) {
      const difference = insideDp - outsideDp;
      this.$('#dewpoint-line').textContent = `Estimated indoor dew point ${luftmRound(insideDp, 1)}°C · outdoor dew point ${luftmRound(outsideDp, 1)}°C · difference ${luftmRound(difference, 1)}°C. This moisture comparison is separate from the heating-cost estimate.`;
    } else {
      this.$('#dewpoint-line').textContent = 'Enter valid indoor and outdoor temperature and humidity readings to show the dew-point comparison.';
    }
    if (Number.isFinite(a.roomVolume) && Number.isFinite(a.replacementPercent)) {
      this.$('#volume-line').textContent = `Room volume: ${luftmRound(a.roomVolume, 1)}m³ · estimated air replaced: ${luftmRound(a.roomVolume * a.replacementFraction, 1)}m³ (${luftmRound(a.replacementPercent, 0)}%).`;
    }
  }

  markCalculationStale() {
    if (this.hasCalculated && this.$('#result')) {
      this.$('#result').classList.add('hidden');
      this.$('#summary-line').textContent = 'Assumptions changed — confirm and calculate again';
    }
    this.hasCalculated = false;
  }

  calculate() {
    const a = this.getAssumptions();
    const error = this.validate(a);
    if (error) {
      this.$('#save-status').textContent = error;
      this.$('#save-status').setAttribute('role', 'alert');
      return;
    }

    const airVolume = a.roomVolume * a.replacementFraction;
    const deltaT = Math.max(0, a.indoorTarget - a.outdoorTemp);
    const airDensityKgM3 = 1.2;
    const specificHeatJkgK = 1005;
    const usefulHeatKWh = (airDensityKgM3 * airVolume * specificHeatJkgK * deltaT) / 3600000;

    let energyPurchasedKWh = usefulHeatKWh;
    let unitRateP = a.electricityP;
    let energyName = 'electricity';
    let systemLabel = 'Direct electric heating · 100%';
    if (a.heatingSystem === 'gas') {
      energyPurchasedKWh = usefulHeatKWh / a.boilerEfficiency;
      unitRateP = a.gasP;
      energyName = 'gas';
      systemLabel = `Gas boiler · ${luftmRound(a.boilerEfficiency * 100, 0)}% efficiency`;
    } else if (a.heatingSystem === 'heatpump') {
      energyPurchasedKWh = usefulHeatKWh / a.heatPumpCop;
      unitRateP = a.electricityP;
      energyName = 'electricity';
      systemLabel = `Heat pump · COP ${luftmRound(a.heatPumpCop, 1)}`;
    } else if (a.heatingSystem === 'custom') {
      energyPurchasedKWh = usefulHeatKWh / a.customFactor;
      unitRateP = a.electricityP;
      energyName = 'energy';
      systemLabel = `Custom heat-output factor · ${luftmRound(a.customFactor, 2)}`;
    }
    const costPence = energyPurchasedKWh * unitRateP;
    const costPounds = costPence / 100;
    const insideDewPoint = this.dewPoint(a.indoorTemp, a.indoorRh);
    const surfaceRisk = a.surfaceTemp !== null && Number.isFinite(insideDewPoint) && a.surfaceTemp <= insideDewPoint;
    const result = {
      roomVolumeM3: a.roomVolume,
      exchangedAirM3: airVolume,
      replacementPercent: a.replacementPercent,
      deltaTC: deltaT,
      usefulHeatKWh,
      energyPurchasedKWh,
      energyName,
      unitRateP,
      costPence,
      costPounds,
      heatingSystem: a.heatingSystem,
      systemLabel,
      insideDewPointC: insideDewPoint,
      surfaceTempC: a.surfaceTemp,
      surfaceRisk,
      assumptions: a,
    };
    this.lastResult = result;
    this.hasCalculated = true;
    this.$('#result').classList.remove('hidden');
    this.$('#result-cost').textContent = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(costPounds);
    this.$('#result-pence').textContent = `${luftmRound(costPence, 3).toFixed(3)}p for this airing scenario`;
    this.$('#result-useful').textContent = `${luftmRound(usefulHeatKWh, 3).toFixed(3)} kWh`;
    this.$('#result-room-volume').textContent = `${luftmRound(a.roomVolume, 1)}m³`;
    this.$('#result-air-volume').textContent = `${luftmRound(airVolume, 1)}m³ (${luftmRound(a.replacementPercent, 0)}%)`;
    this.$('#result-energy-input').textContent = `${luftmRound(energyPurchasedKWh, 3).toFixed(3)} kWh ${energyName}`;
    this.$('#result-system').textContent = systemLabel;
    this.$('#result-rate').textContent = `${luftmRound(unitRateP, 2).toFixed(2)}p/kWh`;
    this.$('#result-delta').textContent = `${luftmRound(deltaT, 1)}°C`;
    this.$('#result-explanation').textContent = deltaT > 0
      ? `This estimates the heat needed to warm ${luftmRound(airVolume, 1)}m³ of assumed replacement air from ${luftmRound(a.outdoorTemp, 1)}°C to ${luftmRound(a.indoorTarget, 1)}°C. It excludes standing charges and unmeasured heat loss from walls, floors, furniture and moisture evaporation.`
      : 'The outside air is at or warmer than your selected indoor target. This simplified model therefore calculates no additional reheating requirement. It does not estimate cooling costs.';
    this.$('#surface-warning').hidden = !surfaceRisk;
    if (surfaceRisk) {
      this.$('#surface-warning').textContent = `Condensation may occur: the measured surface (${luftmRound(a.surfaceTemp, 1)}°C) is at or below the estimated indoor dew point (${luftmRound(insideDewPoint, 1)}°C).`;
    }
    this.$('#summary-line').textContent = `Estimated additional reheating cost: ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(costPounds)}`;
    this.$('#save-status').textContent = 'Estimate calculated using the assumptions shown above.';
    this.dispatchEvent(new CustomEvent('luftm-cost-calculated', { bubbles: true, composed: true, detail: result }));
  }

  collectSettingsFromCalculator() {
    const a = this.getAssumptions();
    return {
      ...this.settings,
      electricityP: a.electricityP,
      gasP: a.gasP,
      tariffMode: 'custom',
      heatingSystem: a.heatingSystem,
      boilerEfficiency: a.boilerEfficiency,
      heatPumpCop: a.heatPumpCop,
      customFactor: a.customFactor,
      roomPreset: a.roomPreset,
      customArea: a.area,
      ceilingHeight: a.ceiling,
      replacementPercent: a.replacementPercent,
      customReplacementPercent: a.replacementPercent,
      indoorTargetC: a.indoorTarget,
    };
  }

  saveDefaultsFromCalculator() {
    const a = this.getAssumptions();
    const error = this.validate(a);
    if (error) {
      this.$('#save-status').textContent = error;
      return;
    }
    this.settings = this.collectSettingsFromCalculator();
    const ok = luftmSaveSettings(this.settings);
    this.updateSettingsFields();
    this.$('#save-status').textContent = ok ? 'Your calculator assumptions and energy rates have been saved on this device.' : 'Could not save settings in this browser. Check browser storage permissions.';
    this.updateSettingsTariffStatus();
  }

  saveSettingsPanel() {
    const electricityP = luftmNumber(this.value('settings-electricity'), NaN);
    const gasP = luftmNumber(this.value('settings-gas'), NaN);
    const efficiency = luftmNumber(this.value('settings-efficiency'), NaN) / 100;
    const cop = luftmNumber(this.value('settings-cop'), NaN);
    if (![electricityP, gasP, efficiency, cop].every(Number.isFinite) || electricityP < 0 || gasP < 0 || electricityP > 1000 || gasP > 1000 || efficiency < 0.5 || efficiency > 1.1 || cop < 1 || cop > 8) {
      this.$('#settings-tariff-status').textContent = 'Check the prices, boiler efficiency and heat-pump COP values.';
      return;
    }
    this.settings = {
      ...this.settings,
      electricityP,
      gasP,
      tariffMode: 'custom',
      heatingSystem: this.value('settings-heating'),
      boilerEfficiency: efficiency,
      heatPumpCop: cop,
    };
    const ok = luftmSaveSettings(this.settings);
    this.syncCalculatorFromSettings();
    this.updateSettingsTariffStatus();
    this.updateTariffLabel();
    this.$('#settings-tariff-status').textContent = ok
      ? 'Saved. These unit rates will pre-fill future estimates on this device. Standing charges remain excluded.'
      : 'Could not save settings in this browser. Check browser storage permissions.';
  }

  syncCalculatorFromSettings() {
    this.setValue('heating-system', this.settings.heatingSystem);
    this.setValue('boiler-efficiency', luftmRound(this.settings.boilerEfficiency * 100, 0));
    this.setValue('heat-pump-cop', this.settings.heatPumpCop);
    this.setValue('custom-factor', this.settings.customFactor);
    this.setValue('electricity-price', this.settings.electricityP);
    this.setValue('gas-price', this.settings.gasP);
    this.updateHeatingFields();
    this.$('#confirmed').checked = false;
    this.$('#calculate-button').disabled = true;
    this.markCalculationStale();
  }

  restoreReferenceTariffs() {
    const reference = luftmGetReferenceTariff();
    this.settings.electricityP = reference.electricityP;
    this.settings.gasP = reference.gasP;
    this.settings.tariffMode = 'reference';
    this.settings.tariffLabel = reference.label;
    luftmSaveSettings(this.settings);
    this.setValue('settings-electricity', reference.electricityP);
    this.setValue('settings-gas', reference.gasP);
    this.setValue('electricity-price', reference.electricityP);
    this.setValue('gas-price', reference.gasP);
    this.$('#confirmed').checked = false;
    this.$('#calculate-button').disabled = true;
    this.markCalculationStale();
    this.updateTariffLabel();
    this.updateSettingsTariffStatus();
    this.$('#settings-tariff-status').textContent = `Restored: ${reference.label}. Check the Ofgem page for your region and payment method.`;
  }
}

if (!customElements.get('luftm-cost-calculator')) {
  customElements.define('luftm-cost-calculator', LuftMCostCalculator);
}
