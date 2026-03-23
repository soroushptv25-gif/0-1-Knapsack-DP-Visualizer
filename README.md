# 0/1 Knapsack DP Visualizer — Full Explanation

## How the Three Files Work Together

```
index.html  ←→  styles.css  ←→  script.js
  (WHAT)         (HOW IT LOOKS)  (HOW IT BEHAVES)
```

---

## FILE 1: index.html — Page Structure

**What it does:** Defines the skeleton — all the HTML elements that exist on screen.

### Key Sections

| Element | ID / Class | Purpose |
|---|---|---|
| `<header>` | — | Sticky top bar with title + CLO badge |
| `.main-layout` | — | CSS Grid: 420px left + flexible right |
| `.left-panel` | — | Controls, stats, explanation, history |
| `.right-panel` | — | Tabs: DP Table, Brute Force, CLO-2, CLO-3, Learn |
| `#status-dot` | status-dot | Colored circle: idle/ready/playing/paused/done |
| `#inp-weights` | inp-weights | Text input for comma-separated weights |
| `#inp-values` | inp-values | Text input for comma-separated values |
| `#inp-capacity` | inp-capacity | Number input for knapsack capacity W |
| `#speed-slider` | speed-slider | Range 1–16 → maps to 0.25×–4× speed |
| `#btn-build/step/play/pause/reset` | — | Playback control buttons |
| `#stat-ops/includes/skips/optimal` | — | Live stat counter displays |
| `#explanation` | explanation | Plain-English step explanation box |
| `#history-body` | history-body | `<tbody>` where history rows are injected |
| `#dp-svg` | dp-svg | The DP table — entirely drawn by JavaScript |
| `#items-list` | items-list | Item boxes (weight/value/ratio/selected) |
| `#pseudo-body` | pseudo-body | Pseudocode lines injected by JS |
| `#bf-svg` | bf-svg | Brute force decision tree SVG |
| `#traceback-svg` | traceback-svg | Traceback path SVG |
| `#greedy-svg` | greedy-svg | Greedy vs DP bar chart SVG |

### Tab System
Five `.tab-content` divs, only the `.active` one is `display:flex`. Clicking a `.tab-btn` calls `switchTab('name')` which moves the `.active` class.

### Why HTML is Separate
HTML is the **structure** — it should only say "there is a table here" not "the table has a blue background" (that's CSS) or "the table fills itself with data" (that's JavaScript).

---

## FILE 2: styles.css — Visual Styling

**What it does:** Makes everything look the way it does.

### Color System

All colors live in `:root {}` as CSS custom properties. This means to change the entire theme, you only edit one place:

```css
:root {
  --bg: #0a0c10;      /* main background */
  --accent: #38bdf8;  /* sky blue highlight */
  --green: #22c55e;   /* include / selected */
  --red: #f43f5e;     /* exclude / error */
  --yellow: #fbbf24;  /* traceback / ratio */
  --purple: #a78bfa;  /* optimal value */
}
```

### Layout: CSS Grid
```css
.main-layout {
  display: grid;
  grid-template-columns: 420px 1fr; /* Fixed left, flexible right */
}
@media (max-width: 980px) {
  .main-layout { grid-template-columns: 1fr; } /* Stack on mobile */
}
```

### Status Dot Animation
```css
.status-dot.playing {
  animation: pulse 1s infinite; /* Opacity blink while running */
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}
```

### Cell State Colors (DP Table)
```
'empty'     → dark navy     — not yet computed
'computing' → blue tint     — currently being processed
'include'   → green tint    — item was included here
'filled'    → dim green     — computed, item excluded
'traceback' → orange tint   — on the traceback path
```

### Key CSS Techniques Used
- **CSS Variables** — centralized color palette
- **CSS Grid** — two-column layout
- **Flexbox** — button rows, stat grids, legend
- **Transitions** — `transition: all 0.2s` on buttons for smooth hover
- **Keyframe animation** — pulsing status dot
- **Position sticky** — header stays visible on scroll
- **Pseudo-elements** — `::before` on item boxes creates the colored left stripe
- **Media queries** — responsive layout switch at 980px

---

## FILE 3: script.js — All Logic

**What it does:** Powers every interaction and renders every visualization.

### The Two-Phase Architecture

```
Phase 1: buildSteps()
  → Computes the complete DP table (all K[i][w] values)
  → Packages every decision into a "step" object array
  → Stores in state.steps[]

Phase 2: applyStep(step)
  → Called once per step (manually or via timer)
  → Updates stats, explanation, pseudocode, cell colors, SVG
```

This design allows **pause, rewind, and variable speed** — because all steps are pre-computed and just need to be "played back."

### The State Object

```javascript
let state = {
  items: [],         // [{w, v, name, ratio}]
  W: 0,              // Knapsack capacity
  n: 0,              // Number of items
  K: [],             // DP table: K[0..n][0..W]
  steps: [],         // All pre-computed steps
  stepIdx: -1,       // Current position in steps[]
  playing: false,    // Auto-play active?
  playTimer: null,   // setTimeout handle
  status: 'idle',    // UI status
  stats: {ops, includes, skips},
  history: [],
  selectedItems: new Set(),  // 0-based indices of selected items
  cellState: [],     // Visual state of each K[i][w] cell
};
```

### Step Object Structure

```javascript
{
  type:    'include' | 'noinclude' | 'skip' | 'traceback-include' | 'traceback-skip' | 'done',
  i:       1..n,      // Item row
  w:       0..W,      // Capacity column
  desc:    'HTML...',  // Explanation text for the explanation box
  pseudo:  0..8,       // Maps to a pseudocode line via PSEUDO_IDX_MAP
  val:     number,     // K[i][w] value
  action:  'include' | 'skip',  // For stats counting
  item:    number,     // 0-based item index (traceback steps)
  selected: [...]      // Final selected items (done step only)
}
```

### DP Algorithm (the actual math)

```javascript
// K[i][w] = max value using items 1..i with capacity w
for (let i = 1; i <= n; i++) {
  for (let w = 0; w <= W; w++) {
    if (weights[i-1] > w) {
      K[i][w] = K[i-1][w];                                    // Can't fit → skip
    } else {
      K[i][w] = Math.max(
        K[i-1][w],                                            // Option 1: exclude
        values[i-1] + K[i-1][w - weights[i-1]]               // Option 2: include
      );
    }
  }
}
```

### Playback Engine

```
play() → setInterval loop via scheduleNext()
           ↓
       scheduleNext() → setTimeout(getDelay())
           ↓
       stepOnce() → state.stepIdx++ → applyStep()
```

The delay comes from the speed slider:
```javascript
function getDelay() {
  const v = parseInt(slider.value); // 1–16
  return Math.round(1600 / (v * 0.25 * 4));
  // v=4 → speed=1× → delay=400ms
  // v=16 → speed=4× → delay=100ms
  // v=1 → speed=0.25× → delay=1600ms
}
```

### SVG Rendering

All visualizations are SVG drawn by building HTML strings then setting `svg.innerHTML`. This is faster than DOM API for many elements.

**DP Table cells** = `<rect>` (background) + `<text>` (value) pairs  
**Arrows** = `<line>` drawn from K[i-1][w-wᵢ] to K[i][w] during include steps  
**Decision tree** = BFS traversal, nodes positioned using `(pos + 0.5) * width / nodesAtLevel`  
**Bar charts** = `<rect>` heights proportional to `value / maxValue * maxHeight`

### CLO Coverage

| CLO | Where | What |
|---|---|---|
| CLO-1 | Brute Force tab | O(2ⁿ) decision tree + O(nW) comparison |
| CLO-1 | Pseudocode lines 1-3 | Outer+inner loop = O(nW) |
| CLO-2 | Ratio Sort tab | Items sorted by v/w ratio |
| CLO-2 | Traceback visualization | DP table search backwards |
| CLO-3 | Pseudocode lines 3-7 | Include/exclude recurrence |
| CLO-3 | Greedy vs DP tab | Bar chart counterexample |

### The Greedy Counterexample

With the "Greedy Fails" preset (w=[1,2,3], v=[6,10,12], W=5):

```
Ratios:  Item1=6.00, Item2=5.00, Item3=4.00
Greedy picks: Item1 (w=1,v=6) + Item2 (w=2,v=10) + Item3? (w=3, total w=6>5 ✗)
  → Item1 + Item2 = weight=3, value=16

DP finds:     Item2 (w=2,v=10) + Item3 (w=3,v=12) = weight=5, value=22

Greedy value=16, DP value=22 → Greedy missed 6 units of value!
```

---

## How to Use the Files

Place all three files in the same folder:
```
knapsack_visualizer/
├── index.html    ← Open this in a browser
├── styles.css    ← Must be in same folder
└── script.js     ← Must be in same folder
```

Open `index.html` in any modern browser. No server required.
