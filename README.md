# EcoPrompt · CO2ntext

EcoPrompt is a Chrome extension that overlays real-time estimates of energy, carbon, and water use for every AI response. It keeps all computations on-device, nudges greener prompting habits, and gives you exportable metrics for ESG or research reporting.

## Highlights
- 🔍 **Impact Label** – Adds a pill under each detected AI response (ChatGPT, Claude, Gemini, etc.) that shows ⚡ Wh, 🌍 g CO₂, and 💧 mL of water plus a transparent methodology tooltip.
- 📊 **Floating Footprint Widget** – Bottom-right dashboard with daily totals, gradient progress bar, and one-click reset.
- 🧠 **Prompt Preview** – While you type, EcoPrompt runs a lightweight on-device embedding check (keywords like “draw”, “render”, “transcribe”) to guess the task type and preview the Wh/CO₂/water before you ever press Enter.
- 🌱 **Greener Prompt Tips** – Toast appears when a response crosses ~1500 tokens or contains generated media, with concrete reduction ideas.
- ⚙️ **Model Profiles & Grid Tuning** – Pick Small/Balanced/Large model classes plus carbon-intensity presets so the coefficients match your deployment.
- 📤 **CSV / JSON Export** – Popup lets you download daily aggregates (date, tokens, Wh, CO₂ g, water mL) for logs or ESG reports.
- 🛡️ **Local & Private** – No requests leave your browser session; constants load from the bundled `data/energy_reference.json`.

## Project Structure
```
manifest.json            # MV3 manifest
src/
  background.js          # Initializes defaults and handles reset/clear messages
  contentScript.js       # Detection, maths, UI injection, storage updates
popup/
  popup.html|css|js      # Settings, theme, exports, reset buttons
styles/content.css       # Shared styling for injected UI
data/energy_reference.json
icons/icon16|48|128.png
```

## Run It Locally
1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** (top-right) and click **Load unpacked**.
3. Select this folder (`CO2ntext/`).  
4. Pin “EcoPrompt” from the toolbar to access the popup.

> Tip: The extension listens on all `http`/`https` URLs but only injects UI when it finds common assistant-response selectors (`[data-message-author-role="assistant"]`, `.ai-response`, etc.). You can tweak `RESPONSE_SELECTORS` inside `src/contentScript.js` if a specific app uses different markup.

## How Calculations Work
| Step | Details |
| --- | --- |
| Detect modality | Looks for actual `<img>/<canvas>` for images, `<audio>` for audio, and keywords for PDFs/long text. |
| Size estimate | Text/PDF tokens ≈ chars ÷ 4, audio minutes from cues, image count from DOM. |
| Apply coefficients | Uses `data/energy_reference.json` (Stanford CRFM 2024, Poddar et al. 2023, CodeCarbon 2023). Mode switch scales Wh/1k tokens: Small 0.2, Balanced 0.5, Large 1.0 (factor applies to every modality). |
| Convert to CO₂ & water | Grid intensity slider (300/400/500 g CO₂ per kWh) + 1 L/kWh water default. |
| Display & store | Renders the label + widget, pushes session data to `chrome.storage.sync`, and keeps the latest 500 entries for exports. |

### 🧠 Short answer

If a user asks something like **“Generate an image of a monkey dancing,”** EcoPrompt still estimates the footprint — it simply switches from the text coefficient to the image-generation one. The logic stays the same; only the per-task energy constant changes.

### ⚙️ Step-by-step logic (under the hood)

1. **Classify intent**  
   A lightweight rule set checks the prompt/response text:
   - `draw`, `generate an image`, `illustration`, `photo`, `create picture` → **image**
   - `transcribe`, `speech`, `audio` → **audio**
   - (future) `video`, `animation`, `frames` → **video**
   - otherwise → **text**

   ```js
   const TASK_COEFFICIENTS = {
     text:  { Wh_per_1k_tokens: 0.5 },
     image: { Wh_per_image: 4.0 },
     audio: { Wh_per_min: 0.8 },
     video: { Wh_per_sec: 3.0 }
   };
   ```

2. **Apply the matching formula**

| Task type | Formula | Example coefficient |
| --- | --- | --- |
| Text (chat, essays, Q&A) | `Wh = (tokens / 1000) × 0.5` | 0.5 Wh / 1k tokens |
| Image generation (Stable Diffusion, DALL·E) | `Wh = num_images × 4.0` | 4 Wh / 512×512 image |
| Audio / transcription | `Wh = minutes × 0.8` | 0.8 Wh / min |
| Video / high-res (stretch) | `Wh = seconds × 3.0` | 3 Wh / sec |

3. **Convert energy into CO₂ & water**

```text
co2_g   = (energy_Wh / 1000) * grid_g_per_kWh       // usually 400 g/kWh
water_mL = (energy_Wh / 1000) * water_L_per_kWh * 1000 // usually 1 L/kWh
```

### 🧮 Example: “Generate an image of a monkey dancing”

- Intent → image generation (1 output image)
- Energy = `1 × 4 Wh = 4 Wh`
- CO₂ = `(4 / 1000) × 400 = 1.6 g`
- Water = `(4 / 1000) × 1 × 1000 = 4 mL`

EcoPrompt label:

```
♻️ Estimated impact: 4 Wh • 1.6 g CO₂ • 4 mL water
(Image generation — approx. SDXL-class model, 512×512 px)
```

### Edge Handling
- Ignores system/short messages (< 20 chars) unless media is present.
- Waits 0.5 s post-mutation so streaming responses settle before labeling.
- Falls back to global averages when settings aren’t configured.
- Shared totals across tabs via `chrome.storage.sync`; resetting today clears both the totals and same-day history entries.

## Customizing & Exporting
- **Model profile** and **grid intensity** live under the popup’s _General_ tab.
- **Theme** (Sage, Charcoal, Sunrise) adjust the injected UI palette without leaving the device.
- **Data tab** shows today’s totals, exports JSON/CSV, and includes reset/clear controls. Exports contain: `date,total_tokens,total_Wh,total_CO2_g,total_water_mL`.
- **Manual entry** within the Data tab lets you log large offline jobs (e.g., gigantic CSV uploads or batch diffusion runs). Pick the task type, enter the estimated tokens/images/minutes, and the turn is added to the same totals/history pipeline for accurate reporting.
- **Prompt preview cards** (auto-injected below AI textareas) reuse the same coefficient table plus an embedding-based classifier so you can tweak a resource-heavy prompt before sending it.

## Stretch Ideas
- Hook a live carbon-intensity API and swap `gridIntensity` dynamically.
- Add a “Green Score” badge or leaderboard using the stored history.
- Build an org dashboard by syncing exports to a shared storage location.

---
Built for the hackathon as a privacy-first, explainable sustainability companion: *“See the impact behind every prompt.”*
