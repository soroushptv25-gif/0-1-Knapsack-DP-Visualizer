/*
=======================================================================
  FILE 3: script.js — ALL LOGIC, ALGORITHM, AND RENDERING
=======================================================================
  WHAT THIS FILE DOES:
  --------------------
  Contains every piece of JavaScript that makes the visualizer work:
  1.  Data definitions (presets, pseudocode lines)
  2.  Application state object
  3.  Input parsing
  4.  DP algorithm + step generation
  5.  Playback engine (play / pause / step / reset)
  6.  DP table SVG renderer
  7.  Items panel renderer
  8.  Knapsack summary updater
  9.  Pseudocode renderer + line highlighter
  10. Brute-force decision tree renderer (CLO-1)
  11. Ratio sort bar chart renderer (CLO-2)
  12. Traceback path renderer (CLO-2)
  13. Greedy vs DP comparison renderer (CLO-3)
  14. UI helper functions
  15. Tab switching + collapsible sections
  16. Initialization

  KEY DESIGN PATTERN:
  -------------------
  The app works in two phases:
    Phase 1 — buildSteps(): computes the ENTIRE DP table upfront,
              then packages every cell computation into a "step" object.
    Phase 2 — applyStep(): called once per step (manually or via timer),
              reads the pre-computed step and updates the UI.
  This lets us pause, rewind (by replaying from scratch), and vary speed.
=======================================================================
*/


// ══════════════════════════════════════════════════════════════
//  SECTION 1: PRESET DATA
//  Four ready-made example datasets the user can load.
//  Each has weights[], values[], W (capacity), and a label.
//
//  PRESET 1 "Classic"      — balanced, all decisions clean
//  PRESET 2 "Greedy Fails" — w=[1,2,3] v=[6,10,12] W=5
//    Ratios: 6, 5, 4 → greedy picks Item1+Item2 = v=16
//    DP finds:         Item2+Item3 = v=22  ← BETTER!
//  PRESET 3 "Tight Fit"   — capacity barely fits chosen items
//  PRESET 4 "Larger Set"  — more items, bigger table
// ══════════════════════════════════════════════════════════════
const PRESETS = [
  { weights:[2,3,4,5],   values:[3,4,5,6],    W:5,  label:"Classic 4-item" },
  { weights:[1,2,3],     values:[6,10,12],     W:5,  label:"Greedy Fails (v/w misleads)" },
  { weights:[4,3,2,3],   values:[5,4,3,3],     W:6,  label:"Tight Fit" },
  { weights:[2,4,6,7],   values:[3,6,9,10],    W:11, label:"Larger Set" },
];


// ══════════════════════════════════════════════════════════════
//  SECTION 2: APPLICATION STATE
//  A single object holds ALL mutable state.
//  This makes it easy to reset (just clear this object) and
//  avoids scattered global variables.
// ══════════════════════════════════════════════════════════════
let state = {
  items: [],        // Array of {w, v, name, ratio} — parsed from input
  W: 0,             // Knapsack capacity
  n: 0,             // Number of items
  K: [],            // 2D array K[0..n][0..W] — the DP table values
  steps: [],        // All steps pre-computed by buildSteps()
  stepIdx: -1,      // Index of current step (-1 = not started)
  playing: false,   // Is auto-play running?
  playTimer: null,  // setTimeout handle (so we can cancel it)
  status: 'idle',   // 'idle' | 'ready' | 'playing' | 'paused' | 'done'
  stats: {
    ops: 0,         // Total cell computations done so far
    includes: 0,    // How many "include item" decisions made
    skips: 0        // How many "exclude item" decisions made
  },
  history: [],      // Log of completed steps for history table
  selectedItems: new Set(),  // Indices (0-based) of DP-optimal items
  cellState: [],    // 2D array matching K's size — visual state of each cell
                    // Values: 'empty' | 'computing' | 'include' | 'filled' | 'traceback'
};


// ══════════════════════════════════════════════════════════════
//  SECTION 3: INPUT PARSING
// ══════════════════════════════════════════════════════════════

/**
 * loadPreset(i) — loads preset i into the input fields and resets
 */
function loadPreset(i) {
  const p = PRESETS[i];
  document.getElementById('inp-weights').value  = p.weights.join(',');
  document.getElementById('inp-values').value   = p.values.join(',');
  document.getElementById('inp-capacity').value = p.W;
  reset();
}

/**
 * parseInput() — reads the three input fields and validates them.
 * Returns { weights, values, W, n } or null if invalid.
 *
 * HOW IT WORKS:
 * - Splits comma-separated strings, converts to integers, filters NaN/≤0
 * - Takes the minimum length of weights and values arrays (so mismatched
 *   lengths don't crash anything)
 */
function parseInput() {
  const ws = document.getElementById('inp-weights').value
    .split(',')
    .map(x => parseInt(x.trim()))
    .filter(x => !isNaN(x) && x > 0);

  const vs = document.getElementById('inp-values').value
    .split(',')
    .map(x => parseInt(x.trim()))
    .filter(x => !isNaN(x) && x > 0);

  const W = parseInt(document.getElementById('inp-capacity').value);

  if (!ws.length || !vs.length || isNaN(W) || W <= 0) return null;

  const n = Math.min(ws.length, vs.length); // Use whichever list is shorter
  return { weights: ws.slice(0, n), values: vs.slice(0, n), W, n };
}


// ══════════════════════════════════════════════════════════════
//  SECTION 4: DP ALGORITHM + STEP GENERATION
//
//  This is the heart of the visualizer.
//  buildSteps() does two things:
//    A) Computes the complete DP table (all K[i][w] values)
//    B) Records every decision as a "step" object
//
//  STEP OBJECT STRUCTURE:
//  {
//    type:   string  — 'init'|'item-start'|'skip'|'include'|'noinclude'
//                      |'optimal'|'traceback-skip'|'traceback-include'|'done'
//    i:      number  — row index (which item, 1-based)
//    w:      number  — column index (which capacity)
//    desc:   string  — HTML explanation for the step explanation box
//    pseudo: number  — index into PSEUDO_IDX_MAP (which line to highlight)
//    val:    number  — the value computed at K[i][w]
//    action: string  — 'include'|'skip' (for stats counting)
//    item:   number  — 0-based item index (for traceback steps)
//    selected: array — final list of selected item indices (for 'done' step)
//  }
// ══════════════════════════════════════════════════════════════
function buildSteps() {
  const inp = parseInput();
  if (!inp) {
    setExplanation('<span class="neg">Invalid input!</span> Please check weights, values, and capacity.');
    return;
  }

  const { weights, values, W, n } = inp;

  // Store parsed items in state
  state.W = W;
  state.n = n;
  state.items = weights.map((w, i) => ({
    w,
    v: values[i],
    name: `Item ${i + 1}`,
    ratio: (values[i] / w).toFixed(2)  // value/weight ratio (for CLO-2)
  }));

  // ── PHASE A: Build the complete DP table ──────────────────
  // K[i][w] = max value using items 1..i with capacity w
  // K[0][w] = 0 for all w (base case: no items → no value)
  const K = Array.from({ length: n + 1 }, () => new Array(W + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let w = 0; w <= W; w++) {
      if (weights[i - 1] > w) {
        // Item i is too heavy for capacity w → skip it
        K[i][w] = K[i - 1][w];
      } else {
        // Either skip item i, or include it and add its value
        K[i][w] = Math.max(
          K[i - 1][w],                            // option 1: skip
          values[i - 1] + K[i - 1][w - weights[i - 1]] // option 2: include
        );
      }
    }
  }
  state.K = K;

  // ── PHASE B: Generate step objects ────────────────────────
  const steps = [];

  // STEP: Initialization
  steps.push({
    type: 'init',
    desc: `Initialize DP table K[0..${n}][0..${W}] with zeros. Base case: 0 items = 0 value.`,
    pseudo: 0, i: 0, w: 0
  });

  // STEPS: Fill the DP table row by row
  for (let i = 1; i <= n; i++) {
    const item = state.items[i - 1];

    // Announce we're starting a new item row
    steps.push({
      type: 'item-start', i,
      desc: `Processing <span class="em">Item ${i}</span> (weight=${item.w}, value=${item.v}, ratio=${item.ratio})`,
      pseudo: 1, w: -1
    });

    // Generate one step per cell in this row
    for (let w = 0; w <= W; w++) {
      if (weights[i - 1] > w) {
        // Can't include item i — too heavy
        steps.push({
          type: 'skip', i, w,
          desc: `<span class="em">K[${i}][${w}]</span>: weight=${item.w} > capacity=${w} → ` +
                `<span class="neg">Cannot include</span> Item ${i}. ` +
                `K[${i}][${w}] = K[${i-1}][${w}] = <span class="pos">${K[i][w]}</span>`,
          val: K[i][w],
          pseudo: 2, action: 'skip'
        });
      } else {
        // Can include — compare skip vs include
        const skip_val = K[i - 1][w];
        const inc_val  = values[i - 1] + K[i - 1][w - weights[i - 1]];
        const chosen   = inc_val > skip_val ? 'include' : 'skip';

        steps.push({
          type: chosen === 'include' ? 'include' : 'noinclude',
          i, w,
          desc: `<span class="em">K[${i}][${w}]</span>: ` +
                `skip=${skip_val}, include=${values[i-1]}+K[${i-1}][${w-weights[i-1]}]=${inc_val}. ` +
                (chosen === 'include'
                  ? `<span class="pos">Include</span> Item ${i}! max=${K[i][w]}`
                  : `<span class="neg">Exclude</span> Item ${i}. max=${K[i][w]}`),
          val: K[i][w], skip_val, inc_val,
          pseudo: chosen === 'include' ? 4 : 3,
          action: chosen
        });
      }
    }
  }

  // STEP: Table complete — optimal value found
  steps.push({
    type: 'optimal', i: n, w: W,
    desc: `DP complete! Optimal value = <span class="pos">${K[n][W]}</span> at K[${n}][${W}].`,
    pseudo: 5, val: K[n][W]
  });

  // ── PHASE C: Traceback steps ───────────────────────────────
  // Starting from K[n][W], work backwards to find selected items.
  // At each cell: if K[i][w] == K[i-1][w], item i was NOT taken (move up).
  //              else item i WAS taken (subtract its weight, move up-left).
  let ci = n, cw = W;
  const selected = new Set();

  while (ci > 0 && cw > 0) {
    if (K[ci][cw] === K[ci - 1][cw]) {
      // Same value as row above → item ci was excluded
      steps.push({
        type: 'traceback-skip', i: ci, w: cw,
        desc: `Traceback: K[${ci}][${cw}]=${K[ci][cw]} = K[${ci-1}][${cw}]=${K[ci-1][cw]} → ` +
              `<span class="neg">Item ${ci} was NOT taken</span>. Move up to K[${ci-1}][${cw}].`,
        pseudo: 6
      });
      ci--;
    } else {
      // Different value → item ci was included
      selected.add(ci - 1);  // Convert to 0-based index
      steps.push({
        type: 'traceback-include', i: ci, w: cw,
        desc: `Traceback: K[${ci}][${cw}]=${K[ci][cw]} ≠ K[${ci-1}][${cw}]=${K[ci-1][cw]} → ` +
              `<span class="pos">Item ${ci} WAS taken!</span> Move to K[${ci-1}][${cw-weights[ci-1]}].`,
        pseudo: 7, item: ci - 1
      });
      cw -= weights[ci - 1];
      ci--;
    }
  }

  // STEP: Done — announce final result
  steps.push({
    type: 'done', i: -1, w: -1,
    desc: `<span class="pos">Done!</span> Optimal value = ${K[n][W]}. ` +
          `Selected: ${[...selected].sort().map(x => `Item ${x+1}`).join(', ') || 'none'}.`,
    pseudo: 8,
    selected: [...selected]
  });

  // ── Store everything in state ──────────────────────────────
  state.steps    = steps;
  state.stepIdx  = -1;
  state.stats    = { ops: 0, includes: 0, skips: 0 };
  state.history  = [];
  state.selectedItems = new Set();
  // Initialize cell visual states to 'empty'
  state.cellState = Array.from({ length: n + 1 }, () => new Array(W + 1).fill('empty'));

  // ── Update UI for "ready to play" ─────────────────────────
  setStatus('ready');
  updateButtons();
  updateStepCounter();
  renderDPTable();
  renderItems();
  updateKSSummary();
  updateStats();
  renderBFTree();
  renderRatioSort();
  renderGreedyVsDP();
  renderPseudocode();
  setExplanation(
    `Steps built! ${steps.length} steps for ${n} items, capacity ${W}. ` +
    `Press <strong>Play</strong> or <strong>Step</strong>.`
  );
  document.getElementById('btn-step').disabled = false;
  document.getElementById('btn-play').disabled = false;
  document.getElementById('pseudo-toggle').style.display = 'block';
}


// ══════════════════════════════════════════════════════════════
//  SECTION 5: PLAYBACK ENGINE
// ══════════════════════════════════════════════════════════════

/**
 * getDelay() — converts slider position to milliseconds per step.
 * Slider range: 1-16 → speed 0.25× to 4×
 * Formula: speed = value * 0.25 → delay = 1600 / (speed * 4)
 * At 1× speed: delay = 400ms. At 4× speed: delay = 100ms.
 */
function getDelay() {
  const v = parseInt(document.getElementById('speed-slider').value);
  return Math.round(1600 / (v * 0.25 * 4));
}

/**
 * play() — starts auto-advancing steps using setTimeout.
 */
function play() {
  if (state.stepIdx >= state.steps.length - 1) return;
  state.playing = true;
  setStatus('playing');
  updateButtons();
  scheduleNext();
}

/**
 * scheduleNext() — called after each step during auto-play.
 * Uses setTimeout so the browser can repaint between steps.
 * Checks if we've reached the end and stops.
 */
function scheduleNext() {
  if (!state.playing) return;
  if (state.stepIdx >= state.steps.length - 1) {
    pause();
    setStatus('done');
    return;
  }
  state.playTimer = setTimeout(() => {
    stepOnce();
    if (state.stepIdx < state.steps.length - 1) {
      scheduleNext();
    } else {
      setStatus('done');
      state.playing = false;
      updateButtons();
    }
  }, getDelay());
}

/**
 * pause() — stops the auto-play timer without resetting state.
 */
function pause() {
  state.playing = false;
  clearTimeout(state.playTimer);
  if (state.status !== 'done') setStatus('paused');
  updateButtons();
}

/**
 * stepOnce() — advances by exactly one step.
 * Called by the Step button and by scheduleNext() during play.
 */
function stepOnce() {
  if (state.stepIdx >= state.steps.length - 1) return;
  state.stepIdx++;
  applyStep(state.steps[state.stepIdx]);
  updateStepCounter();
}

/**
 * reset() — clears all state and returns to idle.
 * Called by the Reset button.
 */
function reset() {
  pause();
  state.stepIdx   = -1;
  state.playing   = false;
  state.stats     = { ops: 0, includes: 0, skips: 0 };
  state.history   = [];
  state.selectedItems = new Set();
  state.cellState = [];

  setStatus('idle');
  updateButtons();
  updateStepCounter();
  updateStats();
  clearHistoryTable();
  setExplanation('Press <strong>Build Steps</strong> to initialize, then <strong>Play</strong> or <strong>Step</strong> through the algorithm.');
  document.getElementById('dp-svg').innerHTML = '';
  document.getElementById('items-list').innerHTML = '<div class="no-items-msg">Build steps to see items</div>';
  document.getElementById('btn-step').disabled = true;
  document.getElementById('btn-play').disabled  = true;
  document.getElementById('pseudo-toggle').style.display = 'none';
  document.getElementById('pseudo-overlay').style.display = 'none';
  updateKSSummary(true);
}

/**
 * applyStep(step) — the main "apply this step to the UI" function.
 * Called for each step during play or after stepOnce().
 *
 * ORDER OF OPERATIONS:
 * 1. Update counters (stats)
 * 2. Update selected items set (traceback steps)
 * 3. Set the explanation text
 * 4. Highlight the pseudocode line
 * 5. Update cell visual states
 * 6. Re-render the DP table SVG
 * 7. Re-render the items panel
 * 8. Add a row to the history table
 */
function applyStep(step) {
  // ── 1. Update stats ────────────────────────────────────────
  if (step.type === 'include' || step.type === 'noinclude' || step.type === 'skip') {
    state.stats.ops++;
    if (step.action === 'include') state.stats.includes++;
    else if (step.action === 'skip') state.stats.skips++;
  }

  // ── 2. Track selected items ────────────────────────────────
  if (step.type === 'traceback-include') {
    state.selectedItems.add(step.item);
  }
  if (step.type === 'done') {
    step.selected.forEach(x => state.selectedItems.add(x));
    updateKSSummary();
  }

  updateStats();

  // ── 3. Explanation text ────────────────────────────────────
  setExplanation(step.desc);

  // ── 4. Pseudocode highlight ────────────────────────────────
  highlightPseudo(step.pseudo);

  // ── 5. Update cell visual state ────────────────────────────
  if (step.i > 0 && step.w >= 0) {
    // Mark previous "computing" cell as done
    const prevActive = findActiveCells();
    prevActive.forEach(([ri, rw]) => {
      if (state.cellState[ri] && state.cellState[ri][rw] === 'computing') {
        // Whether the include or noinclude decision was made
        state.cellState[ri][rw] = step.type === 'include' ? 'include' : 'filled';
      }
    });

    // Mark current cell as computing (except traceback/done steps)
    if (!['traceback-skip', 'traceback-include', 'optimal', 'done'].includes(step.type)) {
      state.cellState[step.i][step.w] = 'computing';
    }

    // Traceback cells get their own color
    if (step.type === 'traceback-skip' || step.type === 'traceback-include') {
      state.cellState[step.i][step.w] = 'traceback';
    }

    // On 'optimal': finalize all cells
    if (step.type === 'optimal') {
      for (let r = 0; r <= state.n; r++)
        for (let c = 0; c <= state.W; c++)
          if (state.cellState[r][c] === 'computing')
            state.cellState[r][c] = 'filled';
      state.cellState[step.i][step.w] = 'traceback';
    }
  }

  // ── 6. Re-render SVG table ─────────────────────────────────
  renderDPTable(step);

  // ── 7. Re-render items panel ───────────────────────────────
  renderItems();

  // ── 8. Add to history ──────────────────────────────────────
  addHistory(step);

  // Update related visualizations when done
  if (step.type === 'done') {
    updateKSSummary();
    renderGreedyVsDP();
    renderRatioSort();
  }
}

/**
 * findActiveCells() — scans cellState to find any cell marked 'computing'.
 * Returns array of [i, w] pairs.
 */
function findActiveCells() {
  const cells = [];
  for (let i = 0; i <= state.n; i++)
    for (let w = 0; w <= state.W; w++)
      if (state.cellState[i] && state.cellState[i][w] === 'computing')
        cells.push([i, w]);
  return cells;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 6: DP TABLE SVG RENDERER
//
//  Draws the (n+1) × (W+1) grid as an SVG.
//  Each cell is a <rect> + <text> pair.
//  Cell color comes from state.cellState[i][w].
//  An arrow is drawn when an "include" step happens, showing
//  which previous cell the value came from (K[i-1][w-wᵢ]).
// ══════════════════════════════════════════════════════════════

// Cell dimensions and margins (pixels)
const CELL_W   = 44;   // Width of each cell
const CELL_H   = 36;   // Height of each cell
const MARGIN_L = 52;   // Left margin (space for row labels)
const MARGIN_T = 44;   // Top margin (space for column headers)

/**
 * renderDPTable(step) — redraws the entire SVG table.
 * Called after every step to reflect the latest cellState.
 *
 * @param {object} step — optional current step (used for arrow drawing)
 */
function renderDPTable(step) {
  if (!state.n || !state.K.length) return;

  const n = state.n, W = state.W;
  const svgW = MARGIN_L + (W + 1) * CELL_W + 10;
  const svgH = MARGIN_T + (n + 1) * CELL_H + 10;

  const svg = document.getElementById('dp-svg');
  svg.setAttribute('width',  svgW);
  svg.setAttribute('height', svgH);

  // Build SVG as an HTML string (faster than DOM API for many elements)
  let html = `<defs>
    <!-- Glow filter: blurs a copy of the element and merges it behind -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>`;

  // ── Column headers: capacity values 0, 1, 2, ... W ──────────
  for (let w = 0; w <= W; w++) {
    const x = MARGIN_L + w * CELL_W + CELL_W / 2;
    html += `<text x="${x}" y="18" text-anchor="middle" fill="#64748b"
               font-family="JetBrains Mono" font-size="11">${w}</text>`;
  }
  // "capacity →" label
  html += `<text x="${MARGIN_L + (W + 1) * CELL_W / 2}" y="34"
             text-anchor="middle" fill="#64748b"
             font-family="JetBrains Mono" font-size="9">capacity →</text>`;

  // ── Row headers: ∅ (no items), I1, I2, ..., In ───────────────
  for (let i = 0; i <= n; i++) {
    const y = MARGIN_T + i * CELL_H + CELL_H / 2 + 4;
    const label = i === 0 ? '∅' : `I${i}`;
    html += `<text x="${MARGIN_L - 8}" y="${y}" text-anchor="end"
               fill="#94a3b8" font-family="JetBrains Mono" font-size="11">${label}</text>`;
  }

  // ── Draw cells ────────────────────────────────────────────────
  for (let i = 0; i <= n; i++) {
    for (let w = 0; w <= W; w++) {
      const x  = MARGIN_L + w * CELL_W;
      const y  = MARGIN_T + i * CELL_H;
      const cs = state.cellState[i] ? state.cellState[i][w] : 'empty';
      const val = state.K[i][w];

      // Choose colors based on cell state
      let fill      = '#1c2333';   // default: dark navy
      let stroke    = '#252e40';
      let strokeW   = 0.5;
      let textColor = '#64748b';

      if (cs === 'computing') {
        fill = '#0c3a5c'; stroke = '#38bdf8'; strokeW = 1.5; textColor = '#38bdf8';
      } else if (cs === 'include') {
        fill = '#0f3d2e'; stroke = '#22c55e'; strokeW = 1;   textColor = '#22c55e';
      } else if (cs === 'traceback') {
        fill = '#3d1f0a'; stroke = '#fbbf24'; strokeW = 1.5; textColor = '#fbbf24';
      } else if (cs === 'filled') {
        fill = '#1a2e1a'; stroke = '#2e4a2e'; strokeW = 0.5; textColor = '#94a3b8';
      }

      // Special color for traceback-include (the "this item was chosen" highlight)
      if (step && step.type === 'traceback-include' && step.i === i && step.w === w) {
        fill = '#2a1a0a'; stroke = '#fb923c'; strokeW = 2; textColor = '#fb923c';
      }

      // Only show value if cell has been computed (not 'empty' except row 0)
      const displayVal = (cs === 'empty' && i > 0) ? '' : String(val);

      // Apply glow filter to active/traceback cells
      const filter = (cs === 'computing' || cs === 'traceback') ? ' filter="url(#glow)"' : '';

      // Draw cell rectangle
      html += `<rect x="${x+1}" y="${y+1}" width="${CELL_W-2}" height="${CELL_H-2}" rx="3"
        fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"${filter}
        style="transition:fill 0.25s,stroke 0.25s"/>`;

      // Draw value text inside cell
      if (displayVal !== '') {
        const bold = (cs === 'computing' || cs === 'traceback') ? '700' : '400';
        html += `<text x="${x + CELL_W/2}" y="${y + CELL_H/2 + 5}"
          text-anchor="middle" fill="${textColor}"
          font-family="JetBrains Mono" font-size="12" font-weight="${bold}">${displayVal}</text>`;
      }

      // ── Arrow for include decision ───────────────────────────
      // When we include item i at capacity w, the value came from
      // K[i-1][w-wᵢ]. Draw a diagonal arrow from that cell.
      if (step && step.type === 'include' && step.i === i && step.w === w
          && i > 0 && w >= state.items[i-1].w) {
        const prevW = w - state.items[i - 1].w;
        const ax = MARGIN_L + prevW * CELL_W + CELL_W / 2;
        const ay = MARGIN_T + (i - 1) * CELL_H + CELL_H / 2;
        const bx = x + CELL_W / 2;
        const by = y + CELL_H / 2;
        // Dashed line from source cell to current cell
        html += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"
          stroke="#22c55e" stroke-width="1.5" stroke-dasharray="4,2" opacity="0.7"/>`;
        // Dot at source
        html += `<circle cx="${ax}" cy="${ay}" r="3" fill="#22c55e" opacity="0.7"/>`;
      }
    }
  }

  // ── Row highlight: thin border around current row ─────────────
  if (step && step.i > 0 && step.w >= 0) {
    const rowY = MARGIN_T + step.i * CELL_H;
    html += `<rect x="${MARGIN_L}" y="${rowY}" width="${(W+1)*CELL_W}" height="${CELL_H}"
      fill="none" stroke="#38bdf8" stroke-width="0.5" opacity="0.3" rx="2"/>`;
  }

  svg.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 7: ITEMS PANEL RENDERER
//
//  Renders the list of item boxes on the right side of the DP tab.
//  - Current item (being processed) gets a blue border
//  - Selected items (found in traceback) glow green
// ══════════════════════════════════════════════════════════════
function renderItems() {
  if (!state.items.length) return;
  const el = document.getElementById('items-list');

  el.innerHTML = state.items.map((item, i) => {
    const sel = state.selectedItems.has(i);   // Is this item in the optimal solution?
    const cur = state.steps[state.stepIdx] && state.steps[state.stepIdx].i === i + 1;

    return `<div class="item-box${sel ? ' selected glow' : ''}${cur ? ' current' : ''}">
      <div class="item-box-header">
        <span class="item-name">${item.name}</span>
        ${sel ? '<span class="selected-badge">✓ selected</span>' : ''}
      </div>
      <div class="item-tags">
        <span class="item-tag tag-w">w: ${item.w}</span>
        <span class="item-tag tag-v">v: ${item.v}</span>
        <span class="item-ratio">ratio: ${item.ratio}</span>
      </div>
    </div>`;
  }).join('');
}


// ══════════════════════════════════════════════════════════════
//  SECTION 8: KNAPSACK SUMMARY BAR
// ══════════════════════════════════════════════════════════════
function updateKSSummary(clear = false) {
  if (clear || !state.n) {
    ['ks-n', 'ks-W', 'ks-optval', 'ks-items-taken', 'ks-complexity']
      .forEach(id => { document.getElementById(id).textContent = '—'; });
    return;
  }
  document.getElementById('ks-n').textContent = state.n;
  document.getElementById('ks-W').textContent = state.W;
  const optVal = state.K.length ? state.K[state.n][state.W] : '—';
  document.getElementById('ks-optval').textContent  = optVal;
  document.getElementById('ks-items-taken').textContent = state.selectedItems.size || '—';
  document.getElementById('ks-complexity').textContent  = `O(${state.n}×${state.W})=${state.n * state.W}`;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 9: PSEUDOCODE RENDERER
//
//  PSEUDO_LINES: Array of pseudocode line objects, each with:
//    code: HTML string (syntax-highlighted via <span class="kw"> etc.)
//    tip:  Tooltip explanation shown on hover
//    clo:  Which CLO this line demonstrates ('clo1'|'clo2'|'clo3')
//
//  PSEUDO_IDX_MAP: Maps step.pseudo (0-8) → line index to highlight.
//  This is how the algorithm step connects to the pseudocode.
// ══════════════════════════════════════════════════════════════
const PSEUDO_LINES = [
  { code: '<span class="kw">function</span> <span class="fn">KnapsackDP</span>(w[], v[], W, n):',
    tip: 'Function signature: takes weight/value arrays, capacity W, item count n', clo: 'clo1' },
  { code: '  <span class="kw">for</span> i = <span class="num">1</span> <span class="kw">to</span> n:',
    tip: 'Outer loop: iterate over each item i from 1 to n', clo: 'clo1' },
  { code: '    <span class="kw">for</span> w = <span class="num">0</span> <span class="kw">to</span> W:',
    tip: 'Inner loop: every capacity from 0 to W. Total iterations: O(nW)', clo: 'clo1' },
  { code: '      <span class="kw">if</span> w[i] > w:',
    tip: 'Check if item i is too heavy for current capacity w', clo: 'clo3' },
  { code: '        K[i][w] = K[i-1][w]',
    tip: 'Item too heavy — inherit value from previous row (cannot include)', clo: 'clo3' },
  { code: '      <span class="kw">else</span>:',
    tip: 'Item fits — now we decide: include it or not?', clo: 'clo3' },
  { code: '        K[i][w] = <span class="fn">max</span>(K[i-1][w],',
    tip: 'Option 1: EXCLUDE item i → take best value from row above', clo: 'clo3' },
  { code: '                    v[i] + K[i-1][w-w[i]])',
    tip: 'Option 2: INCLUDE item i → add its value + best with remaining capacity', clo: 'clo3' },
  { code: '  <span class="kw">return</span> K[n][W]  <span class="cm">// optimal value</span>',
    tip: 'Return optimal value for n items with full capacity W', clo: 'clo1' },
  { code: '', tip: '' },
  { code: '<span class="cm">// Traceback: find selected items</span>',
    tip: 'Now we trace back to find which items make up the optimal solution', clo: 'clo2' },
  { code: 'i = n; w = W',
    tip: 'Start from bottom-right corner of the DP table', clo: 'clo2' },
  { code: '<span class="kw">while</span> i > <span class="num">0</span> <span class="kw">and</span> w > <span class="num">0</span>:',
    tip: 'Keep tracing until we reach row 0 or capacity 0', clo: 'clo2' },
  { code: '  <span class="kw">if</span> K[i][w] == K[i-1][w]:',
    tip: 'Same value as row above → item i was NOT in optimal solution', clo: 'clo2' },
  { code: '    i = i - 1  <span class="cm">// skip item i</span>',
    tip: 'Move up one row, same column — item i excluded', clo: 'clo2' },
  { code: '  <span class="kw">else</span>: include item i',
    tip: 'Value changed → item i IS in the optimal solution!', clo: 'clo2' },
  { code: '    w = w - w[i]; i = i - 1',
    tip: 'Subtract item i weight and move up to previous row', clo: 'clo2' },
];

// Maps step.pseudo number → which PSEUDO_LINES index to highlight
// step.pseudo: 0=init, 1=outer loop, 2=inner loop/skip, 3=exclude, 4=include, 5=return, 6=tb-skip, 7=tb-include, 8=done
const PSEUDO_IDX_MAP = [2, 1, 3, 6, 7, 8, 13, 15, 8, 11, 14, 15];

/**
 * renderPseudocode() — builds the pseudocode panel HTML.
 * Each line gets a line number, syntax-colored code, CLO badge, and tooltip.
 */
function renderPseudocode() {
  const body = document.getElementById('pseudo-body');
  body.innerHTML = PSEUDO_LINES.map((line, i) => `
    <div class="pseudo-line" id="pline-${i}">
      <span class="ln">${i + 1}</span>
      <span class="code">${line.code}${line.clo ? `<span class="clo-badge ${line.clo}">${line.clo.toUpperCase()}</span>` : ''}</span>
      ${line.tip ? `<div class="pseudo-tooltip">${line.tip}</div>` : ''}
    </div>
  `).join('');
}

/**
 * highlightPseudo(pseudoIdx) — removes all highlights and adds one
 * to the line corresponding to the current step.
 * Auto-scrolls to keep the highlighted line visible.
 */
function highlightPseudo(pseudoIdx) {
  document.querySelectorAll('.pseudo-line').forEach(el => el.classList.remove('highlighted'));
  const lineIdx = PSEUDO_IDX_MAP[Math.min(pseudoIdx, PSEUDO_IDX_MAP.length - 1)];
  const el = document.getElementById(`pline-${lineIdx}`);
  if (el) {
    el.classList.add('highlighted');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}


// ══════════════════════════════════════════════════════════════
//  SECTION 10: BRUTE FORCE DECISION TREE (CLO-1)
//
//  Draws a binary tree where each internal node represents the
//  decision for one item (include left / exclude right).
//  Leaf nodes show total value and weight.
//  Infeasible leaves (w > W) are red.
//  Optimal leaves are purple.
//
//  For n items, the tree has 2^(n+1)-1 nodes total.
//  We only draw up to n=4 items to keep it readable.
// ══════════════════════════════════════════════════════════════
function renderBFTree() {
  const items = state.items.slice(0, Math.min(4, state.n));
  const n = items.length;
  const svg = document.getElementById('bf-svg');
  const W = state.W;

  if (!n) {
    svg.innerHTML = '<text x="50" y="50" fill="#64748b" font-family="JetBrains Mono" font-size="12">Build steps first</text>';
    return;
  }

  const levels = n + 1;                    // Root = level 0, leaves = level n
  const svgH = 40 + levels * 60;           // Height grows with depth
  const svgW = 760;
  svg.setAttribute('height', svgH);

  /**
   * buildNode() — creates a node object with its SVG coordinates.
   * x is evenly distributed across the SVG width for each level.
   */
  function buildNode(level, posInLevel, includedSoFar, w, v) {
    const nodesAtLevel = 1 << level;        // 2^level nodes at this depth
    const xSpan = svgW;
    const x = (posInLevel + 0.5) * xSpan / nodesAtLevel;
    const y = 30 + level * 55;             // 55px per level
    return { level, posInLevel, x, y, w, v, inc: [...includedSoFar], feasible: w <= W };
  }

  // BFS to build all nodes level by level
  let nodes = [], edges = [];
  const queue = [{ level: 0, pos: 0, inc: [], w: 0, v: 0 }];

  while (queue.length) {
    const { level, pos, inc, w, v } = queue.shift();
    const node = buildNode(level, pos, inc, w, v);
    nodes.push(node);

    if (level < n) {
      const item = items[level];
      const lw = w + item.w, lv = v + item.v;  // Left = include
      const lNode = buildNode(level + 1, pos * 2,     [...inc, level], lw, lv);
      const rNode = buildNode(level + 1, pos * 2 + 1, inc,             w,  v);

      edges.push({ x1: node.x, y1: node.y, x2: lNode.x, y2: lNode.y, type: 'include' });
      edges.push({ x1: node.x, y1: node.y, x2: rNode.x, y2: rNode.y, type: 'exclude' });

      queue.push({ level: level + 1, pos: pos * 2,     inc: [...inc, level], w: lw, v: lv });
      queue.push({ level: level + 1, pos: pos * 2 + 1, inc,                  w,     v      });
    }
  }

  let html = '';

  // Draw edges (lines between nodes) first — so nodes draw on top
  edges.forEach(e => {
    const col = e.type === 'include' ? '#22c55e' : '#475569';
    html += `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}"
               stroke="${col}" stroke-width="1.2" opacity="0.6"/>`;
    // Include/exclude label at midpoint
    const mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2 - 4;
    html += `<text x="${mx}" y="${my}" text-anchor="middle" fill="${col}"
               font-family="JetBrains Mono" font-size="9">${e.type === 'include' ? '✓' : '✗'}</text>`;
  });

  // Draw nodes
  const optVal = state.K[state.n][state.W];
  nodes.forEach(nd => {
    const isLeaf = nd.level === n;
    const isOpt  = isLeaf && nd.v === optVal && nd.w <= W;  // This leaf is optimal

    let fill   = isLeaf ? (nd.feasible ? '#0f3d2e' : '#3d1111') : '#1c2333';
    let stroke = isLeaf ? (isOpt ? '#a78bfa' : (nd.feasible ? '#22c55e' : '#f43f5e')) : '#38bdf8';
    if (isOpt) fill = '#2a1a5e';

    const r = isLeaf ? 14 : 11;   // Leaf nodes are slightly larger

    html += `<circle cx="${nd.x}" cy="${nd.y}" r="${r}"
               fill="${fill}" stroke="${stroke}" stroke-width="${isOpt ? 2 : 1}"/>`;

    if (isLeaf) {
      // Show value and weight in leaf
      const col = isOpt ? '#a78bfa' : (nd.feasible ? '#22c55e' : '#f43f5e');
      html += `<text x="${nd.x}" y="${nd.y - 2}"   text-anchor="middle" fill="${col}"
                 font-family="JetBrains Mono" font-size="8" font-weight="700">v=${nd.v}</text>`;
      html += `<text x="${nd.x}" y="${nd.y + 8}"   text-anchor="middle"
                 fill="${nd.feasible ? '#64748b' : '#f43f5e'}"
                 font-family="JetBrains Mono" font-size="7">w=${nd.w}</text>`;
    } else {
      // Show which item this node decides about
      html += `<text x="${nd.x}" y="${nd.y + 4}" text-anchor="middle"
                 fill="#94a3b8" font-family="JetBrains Mono" font-size="9">${nd.level === 0 ? '∅' : `i${nd.level}`}</text>`;
    }
  });

  // Level labels on the left
  for (let l = 0; l <= n; l++) {
    const y = 30 + l * 55;
    html += `<text x="8" y="${y + 4}" fill="#475569" font-family="JetBrains Mono" font-size="9">${l === 0 ? 'Root' : `Decide Item ${l}`}</text>`;
  }

  // Legend
  html += `<text x="${svgW - 8}" y="${svgH - 8}"  text-anchor="end" fill="#a78bfa" font-family="JetBrains Mono" font-size="10">● Optimal leaf(s)</text>`;
  html += `<text x="${svgW - 8}" y="${svgH - 18}" text-anchor="end" fill="#22c55e" font-family="JetBrains Mono" font-size="10">● Feasible leaf</text>`;
  html += `<text x="${svgW - 8}" y="${svgH - 28}" text-anchor="end" fill="#f43f5e" font-family="JetBrains Mono" font-size="10">● Infeasible</text>`;

  svg.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 11: RATIO SORT BAR CHART (CLO-2)
//
//  Sorts items by value/weight ratio (descending) and draws
//  them as boxes in sorted order.
//  Items selected by DP are highlighted green.
// ══════════════════════════════════════════════════════════════
function renderRatioSort() {
  const el = document.getElementById('ratio-sort-viz');
  if (!state.items.length) {
    el.innerHTML = '<div class="no-items-msg">Build steps first</div>';
    return;
  }

  // Sort by ratio descending, keeping original index for DP comparison
  const sorted = [...state.items]
    .map((it, i) => ({ ...it, origIdx: i }))
    .sort((a, b) => b.ratio - a.ratio);

  const svgW = 680, svgH = 90;
  let html = `<svg width="${svgW}" height="${svgH}">`;

  const bw = Math.min(80, (svgW - 40) / sorted.length - 8);

  sorted.forEach((item, i) => {
    const x   = 20 + i * (bw + 8);
    const sel = state.selectedItems.has(item.origIdx);  // Is this in DP solution?
    const fill   = sel ? '#0f3d2e' : '#1c2333';
    const stroke = sel ? '#22c55e' : '#252e40';
    const textColor = sel ? '#22c55e' : '#94a3b8';

    html += `<rect x="${x}" y="8" width="${bw}" height="62" rx="6"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    html += `<text x="${x+bw/2}" y="26" text-anchor="middle" fill="${textColor}"
               font-family="JetBrains Mono" font-size="10" font-weight="700">${item.name.replace('Item', 'I')}</text>`;
    html += `<text x="${x+bw/2}" y="40" text-anchor="middle" fill="#fbbf24"
               font-family="JetBrains Mono" font-size="11" font-weight="700">${item.ratio}</text>`;
    html += `<text x="${x+bw/2}" y="53" text-anchor="middle" fill="#38bdf8"
               font-family="JetBrains Mono" font-size="9">w=${item.w}</text>`;
    html += `<text x="${x+bw/2}" y="64" text-anchor="middle" fill="#22c55e"
               font-family="JetBrains Mono" font-size="9">v=${item.v}</text>`;
    if (i < sorted.length - 1) {
      html += `<text x="${x+bw+4}" y="42" fill="#475569" font-family="JetBrains Mono" font-size="10">›</text>`;
    }
  });

  html += `<text x="20" y="85" fill="#64748b" font-family="JetBrains Mono" font-size="9">
    Sorted by value/weight ratio (highest first). Yellow = ratio. Green highlight = DP-selected.</text>`;
  html += '</svg>';
  el.innerHTML = html;

  renderTraceback();  // Also update the traceback path visualization
}

/**
 * renderTraceback() — draws the traceback path as a sequence of
 * cell boxes with arrows, showing which cells were visited and
 * whether each item was included or excluded.
 */
function renderTraceback() {
  if (!state.K.length) return;
  const svg = document.getElementById('traceback-svg');
  const n = state.n, W = state.W;

  let html = '';

  // Walk the traceback path just like in buildSteps()
  const path = [];
  let ci = n, cw = W;
  while (ci > 0 && cw >= 0) {
    path.push({
      i: ci, w: cw,
      included: state.K[ci][cw] !== state.K[ci - 1][cw]
    });
    if (state.K[ci][cw] !== state.K[ci - 1][cw]) {
      cw -= state.items[ci - 1].w;
    }
    ci--;
  }

  const svgW  = parseInt(svg.getAttribute('width'));
  const bw    = Math.min(90, (svgW - 40) / (path.length || 1) - 10);

  path.forEach((step, i) => {
    const x      = 20 + i * (bw + 10);
    const fill   = step.included ? '#3d1f0a' : '#1c2333';
    const stroke = step.included ? '#fbbf24' : '#38bdf8';

    html += `<rect x="${x}" y="20" width="${bw}" height="50" rx="6"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    html += `<text x="${x+bw/2}" y="38" text-anchor="middle" fill="#e2e8f0"
               font-family="JetBrains Mono" font-size="10" font-weight="700">K[${step.i}][${step.w}]</text>`;
    html += `<text x="${x+bw/2}" y="52" text-anchor="middle" fill="${stroke}"
               font-family="JetBrains Mono" font-size="10">${state.K[step.i][step.w]}</text>`;
    html += `<text x="${x+bw/2}" y="64" text-anchor="middle"
               fill="${step.included ? '#fbbf24' : '#64748b'}"
               font-family="JetBrains Mono" font-size="9">${step.included ? '✓ I' + step.i : '✗'}</text>`;
    if (i < path.length - 1) {
      html += `<text x="${x+bw+5}" y="48" fill="#475569" font-family="JetBrains Mono" font-size="14">←</text>`;
    }
  });

  if (!path.length) {
    html += `<text x="20" y="50" fill="#64748b" font-family="JetBrains Mono" font-size="12">Build &amp; run steps to see traceback path</text>`;
  }

  svg.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 12: GREEDY vs DP COMPARISON (CLO-3)
//
//  Implements the greedy algorithm (sort by ratio, take greedily)
//  and compares its result with the DP optimal result.
//  Draws a bar chart showing which items each approach selected.
// ══════════════════════════════════════════════════════════════
function renderGreedyVsDP() {
  if (!state.items.length) return;

  const items = state.items;
  const W     = state.W;

  // ── Greedy algorithm ──────────────────────────────────────
  // Sort by ratio descending, greedily take items that fit
  const sorted = [...items]
    .map((it, i) => ({ ...it, idx: i }))
    .sort((a, b) => b.ratio - a.ratio);

  let gw = 0, gv = 0;
  const greedy_sel = new Set();
  for (const it of sorted) {
    if (gw + it.w <= W) {
      gw += it.w;
      gv += it.v;
      greedy_sel.add(it.idx);
    }
    // KEY INSIGHT: Unlike fractional knapsack, we can't split items.
    // So even if a high-ratio item doesn't fit, we can't take part of it.
    // This is WHY greedy fails for 0/1 knapsack.
  }

  const optVal      = state.K[state.n][state.W];
  const greedyFails = gv < optVal;  // True when greedy is suboptimal

  // Update text panels
  document.getElementById('greedy-result-bad').innerHTML = `
    <div style="margin-bottom:8px">
      Items: ${greedy_sel.size
        ? [...greedy_sel].sort().map(i => `<code>I${i+1}(w=${items[i].w},v=${items[i].v})</code>`).join(' + ')
        : 'none'}
    </div>
    <div>Total weight: <strong style="color:var(--accent)">${gw}/${W}</strong></div>
    <div>Total value: <strong style="color:${greedyFails ? 'var(--red)' : 'var(--green)'}">${gv}</strong></div>
    ${greedyFails
      ? '<div style="color:var(--red);margin-top:6px;font-weight:700">⚠ Suboptimal! Greedy failed here.</div>'
      : '<div style="color:var(--green);margin-top:6px">✓ Same as DP (greedy happened to work)</div>'}
  `;

  document.getElementById('greedy-result-good').innerHTML = `
    <div style="margin-bottom:8px">
      Items: ${state.selectedItems.size
        ? [...state.selectedItems].sort().map(i => `<code>I${i+1}(w=${items[i].w},v=${items[i].v})</code>`).join(' + ')
        : 'Run traceback first'}
    </div>
    <div>Optimal value: <strong style="color:var(--green)">${optVal}</strong></div>
    ${greedyFails ? `<div style="color:var(--green);margin-top:6px;font-weight:700">✅ DP finds +${optVal - gv} more value</div>` : ''}
  `;

  // ── Bar chart SVG ─────────────────────────────────────────
  const svg    = document.getElementById('greedy-svg');
  const svgW   = 760, svgH = 260;
  let html = '';

  const maxV     = Math.max(optVal, gv, 1);
  const barMaxH  = 140;   // Maximum bar height in pixels

  items.forEach((item, i) => {
    const x        = 60 + i * 80;
    const isDP     = state.selectedItems.has(i);  // Selected by DP?
    const isGreedy = greedy_sel.has(i);            // Selected by greedy?

    // DP bar (left of pair)
    const dpH = (item.v / maxV) * barMaxH;
    html += `<rect x="${x}" y="${180 - dpH}" width="28" height="${dpH}" rx="3"
      fill="${isDP ? '#0f3d2e' : '#1c2333'}"
      stroke="${isDP ? '#22c55e' : '#252e40'}" stroke-width="1.5"/>`;
    html += `<text x="${x+14}" y="${180-dpH-5}" text-anchor="middle"
      fill="${isDP ? '#22c55e' : '#475569'}" font-family="JetBrains Mono" font-size="9">${isDP ? '✓' : ''}</text>`;

    // Greedy bar (right of pair)
    const gH = (item.v / maxV) * barMaxH;
    html += `<rect x="${x+32}" y="${180 - gH}" width="28" height="${gH}" rx="3"
      fill="${isGreedy ? 'rgba(251,191,36,0.2)' : '#1c2333'}"
      stroke="${isGreedy ? '#fbbf24' : '#252e40'}" stroke-width="1.5"/>`;
    html += `<text x="${x+46}" y="${180-gH-5}" text-anchor="middle"
      fill="${isGreedy ? '#fbbf24' : '#475569'}" font-family="JetBrains Mono" font-size="9">${isGreedy ? '✓' : ''}</text>`;

    // Item label below bars
    html += `<text x="${x+30}" y="200" text-anchor="middle"
      fill="#94a3b8" font-family="JetBrains Mono" font-size="10">${item.name.replace('Item','I')}</text>`;
    html += `<text x="${x+30}" y="213" text-anchor="middle"
      fill="#64748b" font-family="JetBrains Mono" font-size="9">v=${item.v},w=${item.w}</text>`;
  });

  // Total bars on the right
  const dpBarX   = 60 + items.length * 80 + 20;
  const dpTotalH = (optVal / maxV) * barMaxH;
  const gTotalH  = (gv     / maxV) * barMaxH;

  html += `<rect x="${dpBarX}" y="${180-dpTotalH}" width="32" height="${dpTotalH}" rx="3"
    fill="#0f3d2e" stroke="#22c55e" stroke-width="2"/>`;
  html += `<text x="${dpBarX+16}" y="${180-dpTotalH-8}" text-anchor="middle"
    fill="#22c55e" font-family="JetBrains Mono" font-size="11" font-weight="700">${optVal}</text>`;

  html += `<rect x="${dpBarX+36}" y="${180-gTotalH}" width="32" height="${gTotalH}" rx="3"
    fill="${greedyFails ? 'rgba(244,63,94,0.2)' : 'rgba(34,197,94,0.2)'}"
    stroke="${greedyFails ? '#f43f5e' : '#22c55e'}" stroke-width="2"/>`;
  html += `<text x="${dpBarX+52}" y="${180-gTotalH-8}" text-anchor="middle"
    fill="${greedyFails ? '#f43f5e' : '#22c55e'}"
    font-family="JetBrains Mono" font-size="11" font-weight="700">${gv}</text>`;
  html += `<text x="${dpBarX+34}" y="200" text-anchor="middle"
    fill="#94a3b8" font-family="JetBrains Mono" font-size="10">TOTAL</text>`;

  // Legend
  html += `<rect x="20" y="225" width="12" height="10" rx="2" fill="#0f3d2e" stroke="#22c55e" stroke-width="1"/>`;
  html += `<text x="36" y="234" fill="#22c55e" font-family="JetBrains Mono" font-size="10">DP (optimal)</text>`;
  html += `<rect x="130" y="225" width="12" height="10" rx="2" fill="rgba(251,191,36,0.2)" stroke="#fbbf24" stroke-width="1"/>`;
  html += `<text x="146" y="234" fill="#fbbf24" font-family="JetBrains Mono" font-size="10">Greedy (ratio sort)</text>`;
  if (greedyFails) {
    html += `<text x="280" y="234" fill="#f43f5e" font-family="JetBrains Mono" font-size="11" font-weight="700">⚠ Greedy suboptimal by ${optVal - gv}</text>`;
  }

  svg.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
//  SECTION 13: UI HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/** setStatus(s) — updates the status dot color and text label */
function setStatus(s) {
  state.status = s;
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = `status-dot ${s}`;  // CSS class determines color
  txt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
}

/** updateButtons() — enables/disables buttons based on current state */
function updateButtons() {
  const { stepIdx, steps } = state;
  const hasSteps = steps.length > 0;
  const atEnd    = stepIdx >= steps.length - 1;
  document.getElementById('btn-step').disabled  = !hasSteps || atEnd || state.playing;
  document.getElementById('btn-play').disabled  = !hasSteps || atEnd || state.playing;
  document.getElementById('btn-pause').disabled = !state.playing;
}

/** updateStepCounter() — shows "Step X / Y" */
function updateStepCounter() {
  document.getElementById('step-counter').textContent =
    `Step ${state.stepIdx + 1} / ${state.steps.length}`;
}

/** updateStats() — updates the four stat box numbers */
function updateStats() {
  document.getElementById('stat-ops').textContent      = state.stats.ops;
  document.getElementById('stat-includes').textContent = state.stats.includes;
  document.getElementById('stat-skips').textContent    = state.stats.skips;
  if (state.K.length) {
    document.getElementById('stat-optimal').textContent = state.K[state.n]?.[state.W] ?? '—';
  }
}

/** setExplanation(html) — updates the explanation box content */
function setExplanation(html) {
  document.getElementById('explanation').innerHTML = html;
}

/**
 * addHistory(step) — prepends a new row to the history table.
 * Keeps only the last 25 rows.
 * Each row is clickable to jump to that step.
 */
function addHistory(step) {
  const tbody = document.getElementById('history-body');

  // Choose colored tag based on step type
  const tag = step.type.includes('include') ? `<span class="tag-fill">include</span>`
            : step.type.includes('traceback') ? `<span class="tag-trace">traceback</span>`
            : `<span class="tag-skip">skip</span>`;

  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${state.stepIdx + 1}</td>
    <td>${step.i > 0  ? step.i : '—'}</td>
    <td>${step.w >= 0 ? step.w : '—'}</td>
    <td>${tag}</td>
    <td>${step.val !== undefined ? step.val : '—'}</td>
  `;
  row.dataset.step = state.stepIdx;  // Store step index for jumpToStep
  row.onclick = () => jumpToStep(parseInt(row.dataset.step));

  // Prepend so newest is at top
  tbody.insertBefore(row, tbody.firstChild);

  // Cap at 25 rows
  while (tbody.children.length > 25) tbody.removeChild(tbody.lastChild);

  // Highlight active row
  document.querySelectorAll('#history-body tr').forEach(r => r.classList.remove('active-row'));
  row.classList.add('active-row');
}

/** clearHistoryTable() — empties the history table */
function clearHistoryTable() {
  document.getElementById('history-body').innerHTML = '';
}

/**
 * jumpToStep(idx) — replays steps from scratch up to step idx.
 * This is how clicking a history row rewinds/fast-forwards.
 * It's not the most efficient approach (replays from scratch each time)
 * but it's correct and simple.
 */
function jumpToStep(idx) {
  const target = idx;
  reset();
  buildSteps();
  for (let i = 0; i <= target; i++) {
    if (i < state.steps.length) {
      state.stepIdx = i;
      applyStep(state.steps[i]);
    }
  }
  updateStepCounter();
  updateButtons();
}


// ══════════════════════════════════════════════════════════════
//  SECTION 14: TAB SWITCHING & COLLAPSIBLE SECTIONS
// ══════════════════════════════════════════════════════════════

/**
 * switchTab(name) — shows one tab content, hides others.
 * Also updates the active button style.
 */
function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  event.target.classList.add('active');
}

/**
 * toggleCollapsible(header) — opens/closes an accordion section.
 * Toggles .open class on both the header and its next sibling (the body).
 */
function toggleCollapsible(header) {
  header.classList.toggle('open');
  const body = header.nextElementSibling;
  body.classList.toggle('open');
}


// ══════════════════════════════════════════════════════════════
//  SECTION 15: EVENT LISTENERS
// ══════════════════════════════════════════════════════════════

// Speed slider: update the label display as user drags
document.getElementById('speed-slider').addEventListener('input', function () {
  const v     = parseInt(this.value);
  // Convert slider integer (1-16) to human-readable speed (0.25x-4x)
  const speed = (v * 0.25).toFixed(2).replace(/\.?0+$/, '');
  document.getElementById('speed-label').textContent = speed + '×';
});


// ══════════════════════════════════════════════════════════════
//  SECTION 16: INITIALIZATION
//  Called once when the page loads.
//  Pre-renders pseudocode and brute force tree with default data.
// ══════════════════════════════════════════════════════════════
renderPseudocode();   // Fill the pseudocode panel with lines
renderBFTree();       // Initial empty tree

// Load preset 0 (Classic 4-item) into inputs and build steps
loadPreset(0);
buildSteps();
