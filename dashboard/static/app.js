/**
 * Smart Resource Manager Control Center
 * Vanilla ES Module Frontend Application
 * 100% Offline, Zero CDNs, Self-Contained SVG/Canvas Engine
 */

// Application State
const state = {
  connected: false,
  managerRunning: false,
  isStale: false,
  lastState: null,
  rules: null,
  feedEvents: [],
  knownEventKeys: new Set(),
  sortCol: "cpu_pct",
  sortAsc: false,
  filterQuery: "",
  theme: localStorage.getItem("srm_theme") || "dark",
  presentationMode: false,
  logLines: [],
  logFilterLevel: "ALL",
  logSearchQuery: "",
  activeDemos: [],
  protectedList: [],

  // Ring buffers
  cpuSparklineHistory: [], // up to 120 samples
  memSparklineHistory: [], // up to 120 samples
  timelineHistory: [],     // up to 180 samples (3 minutes)

  // Previous process status cache for flash animation
  procStatusCache: new Map(),

  // Previous totals for count-up animation
  prevTotals: { warn: 0, renice: 0, pause: 0, kill: 0 },
};

// DOM Elements
const DOM = {
  // Badges & Status
  modeBadge: document.getElementById("mode-badge"),
  connBadge: document.getElementById("conn-badge"),
  uptimeVal: document.getElementById("uptime-val"),
  procsCountVal: document.getElementById("procs-count-val"),
  loadVal: document.getElementById("load-val"),
  serverOfflineBanner: document.getElementById("server-offline-banner"),
  emptyStateScreen: document.getElementById("empty-state-screen"),
  mainContent: document.getElementById("main-content"),

  // KPIs
  cpuPctVal: document.getElementById("cpu-pct-val"),
  cpuGaugeCircle: document.getElementById("cpu-gauge-circle"),
  cpuSparklineCanvas: document.getElementById("cpu-sparkline"),
  cpuPeakVal: document.getElementById("cpu-peak-val"),
  coresBadge: document.getElementById("cores-badge"),

  memPctVal: document.getElementById("mem-pct-val"),
  memGaugeCircle: document.getElementById("mem-gauge-circle"),
  memSparklineCanvas: document.getElementById("mem-sparkline"),
  memFreeText: document.getElementById("mem-free-text"),
  memTotalText: document.getElementById("mem-total-text"),

  // Counters
  counterWarn: document.getElementById("counter-warn"),
  counterRenice: document.getElementById("counter-renice"),
  counterPause: document.getElementById("counter-pause"),
  counterKill: document.getElementById("counter-kill"),

  // Timeline
  timelineCanvas: document.getElementById("timeline-chart"),
  chartContainer: document.getElementById("chart-container"),
  chartTooltip: document.getElementById("chart-tooltip"),

  // Table
  procTableBody: document.getElementById("proc-table-body"),
  procFilterInput: document.getElementById("proc-filter-input"),
  tableSubtitle: document.getElementById("table-subtitle"),

  // Feed & Toasts
  feedContainer: document.getElementById("feed-container"),
  feedCountBadge: document.getElementById("feed-count-badge"),
  toastContainer: document.getElementById("toast-container"),

  // Ladder
  ladderMemLimit: document.getElementById("ladder-mem-limit"),
  ladderCpuLimit: document.getElementById("ladder-cpu-limit"),
  ladderTRenice: document.getElementById("ladder-t-renice"),
  ladderTKill: document.getElementById("ladder-t-kill"),
  ladderLeakSecs: document.getElementById("ladder-leak-secs"),
  ladderNiceVal: document.getElementById("ladder-nice-val"),
  ladderGraceCycles: document.getElementById("ladder-grace-cycles"),

  // Demo Drawer
  demoDrawer: document.getElementById("demo-drawer"),
  btnDemoPanel: document.getElementById("btn-demo-panel"),
  btnCloseDemo: document.getElementById("btn-close-demo"),
  btnDemoCpu: document.getElementById("btn-demo-cpu"),
  btnDemoLeak: document.getElementById("btn-demo-leak"),
  btnDemoStubborn: document.getElementById("btn-demo-stubborn"),
  btnDemoStop: document.getElementById("btn-demo-stop"),
  activeDemosList: document.getElementById("active-demos-list"),

  // Settings Drawer
  settingsDrawer: document.getElementById("settings-drawer"),
  btnOpenSettings: document.getElementById("btn-open-settings"),
  btnCloseSettings: document.getElementById("btn-close-settings"),
  settingsForm: document.getElementById("settings-form"),
  cfgDryRun: document.getElementById("cfg-dry-run"),
  cfgCpuLimit: document.getElementById("cfg-cpu-limit"),
  cfgCpuLimitVal: document.getElementById("cfg-cpu-limit-val"),
  cfgMemLimit: document.getElementById("cfg-mem-limit"),
  cfgMemLimitVal: document.getElementById("cfg-mem-limit-val"),
  cfgTRenice: document.getElementById("cfg-t-renice"),
  cfgTReniceVal: document.getElementById("cfg-t-renice-val"),
  cfgTKill: document.getElementById("cfg-t-kill"),
  cfgTKillVal: document.getElementById("cfg-t-kill-val"),
  cfgLeakSecs: document.getElementById("cfg-leak-secs"),
  cfgLeakSecsVal: document.getElementById("cfg-leak-secs-val"),
  cfgNiceValue: document.getElementById("cfg-nice-value"),
  cfgNiceValueVal: document.getElementById("cfg-nice-value-val"),
  cfgGraceCycles: document.getElementById("cfg-grace-cycles"),
  cfgGraceCyclesVal: document.getElementById("cfg-grace-cycles-val"),
  cfgTableRows: document.getElementById("cfg-table-rows"),
  cfgTableRowsVal: document.getElementById("cfg-table-rows-val"),
  protectedChips: document.getElementById("protected-chips"),
  addProtectedInput: document.getElementById("add-protected-input"),
  btnAddProtected: document.getElementById("btn-add-protected"),
  btnSaveConfig: document.getElementById("btn-save-config"),
  saveStatusMsg: document.getElementById("save-status-msg"),

  // Log Modal
  logModal: document.getElementById("log-modal"),
  btnOpenLog: document.getElementById("btn-open-log"),
  btnCloseLog: document.getElementById("btn-close-log"),
  logViewerBody: document.getElementById("log-viewer-body"),
  logLevelFilters: document.getElementById("log-level-filters"),
  logSearchInput: document.getElementById("log-search-input"),
  logAutoscrollChk: document.getElementById("log-autoscroll-chk"),
  btnDownloadLog: document.getElementById("btn-download-log"),

  // Presentation & Theme
  btnTogglePres: document.getElementById("btn-toggle-presentation"),
  exitPresBtn: document.getElementById("exit-pres-btn"),
  btnToggleTheme: document.getElementById("btn-toggle-theme"),
  themeIconMoon: document.getElementById("theme-icon-moon"),
  themeIconSun: document.getElementById("theme-icon-sun"),
};

// ==========================================================================
// Initialization
// ==========================================================================
function init() {
  applyTheme(state.theme);
  bindEvents();
  setupCanvasHiDPI();
  fetchInitialConfig();
  fetchDemoStatus();

  // Start polling
  pollState();
  setInterval(pollState, 1000);

  // Resize listener for canvas redraw
  window.addEventListener("resize", () => {
    setupCanvasHiDPI();
    renderTimelineChart();
    renderSparklines();
  });
}

// ==========================================================================
// Event Bindings
// ==========================================================================
function bindEvents() {
  // Theme Toggle
  DOM.btnToggleTheme.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("srm_theme", state.theme);
    applyTheme(state.theme);
    renderTimelineChart();
    renderSparklines();
  });

  // Presentation Mode Toggle
  DOM.btnTogglePres.addEventListener("click", togglePresentationMode);
  DOM.exitPresBtn.addEventListener("click", togglePresentationMode);
  window.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      // Don't trigger if typing in an input
      if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      e.preventDefault();
      togglePresentationMode();
    } else if (e.key === "Escape") {
      if (state.presentationMode) togglePresentationMode();
      closeAllDrawers();
    }
  });

  // Drawers & Modals
  DOM.btnDemoPanel.addEventListener("click", () => openDrawer(DOM.demoDrawer));
  DOM.btnCloseDemo.addEventListener("click", () => closeDrawer(DOM.demoDrawer));

  DOM.btnOpenSettings.addEventListener("click", () => {
    fetchInitialConfig();
    openDrawer(DOM.settingsDrawer);
  });
  DOM.btnCloseSettings.addEventListener("click", () => closeDrawer(DOM.settingsDrawer));

  DOM.btnOpenLog.addEventListener("click", () => {
    openModal(DOM.logModal);
    fetchLogs();
  });
  DOM.btnCloseLog.addEventListener("click", () => closeModal(DOM.logModal));

  // Close overlays on backdrop click
  [DOM.demoDrawer, DOM.settingsDrawer, DOM.logModal].forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeDrawer(overlay);
        closeModal(overlay);
      }
    });
  });

  // Demo Controls
  DOM.btnDemoCpu.addEventListener("click", () => triggerDemoStart("cpu"));
  DOM.btnDemoLeak.addEventListener("click", () => triggerDemoStart("leak"));
  DOM.btnDemoStubborn.addEventListener("click", () => triggerDemoStart("stubborn"));
  DOM.btnDemoStop.addEventListener("click", triggerDemoStop);

  // Table Sorting
  const sortHeaders = document.querySelectorAll(".proc-table th.sortable");
  sortHeaders.forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.getAttribute("data-sort");
      if (state.sortCol === col) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortCol = col;
        state.sortAsc = col === "name" || col === "state" || col === "status";
      }
      updateSortHeaderUI();
      if (state.lastState) renderProcessTable(state.lastState.processes || []);
    });
  });

  // Table Search Filter
  DOM.procFilterInput.addEventListener("input", (e) => {
    state.filterQuery = e.target.value.toLowerCase().trim();
    if (state.lastState) renderProcessTable(state.lastState.processes || []);
  });

  // Settings Sliders two-way bind
  bindSliderSync(DOM.cfgCpuLimit, DOM.cfgCpuLimitVal, "%");
  bindSliderSync(DOM.cfgMemLimit, DOM.cfgMemLimitVal, " MB");
  bindSliderSync(DOM.cfgTRenice, DOM.cfgTReniceVal, "s");
  bindSliderSync(DOM.cfgTKill, DOM.cfgTKillVal, "s");
  bindSliderSync(DOM.cfgLeakSecs, DOM.cfgLeakSecsVal, "s");
  bindSliderSync(DOM.cfgNiceValue, DOM.cfgNiceValueVal, "");
  bindSliderSync(DOM.cfgGraceCycles, DOM.cfgGraceCyclesVal, "");
  bindSliderSync(DOM.cfgTableRows, DOM.cfgTableRowsVal, "");

  // Protected Chips Add
  DOM.btnAddProtected.addEventListener("click", addProtectedChip);
  DOM.addProtectedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addProtectedChip();
    }
  });

  // Settings Save Form
  DOM.settingsForm.addEventListener("submit", saveConfigForm);

  // Log Viewer Controls
  DOM.logLevelFilters.addEventListener("click", (e) => {
    if (e.target.classList.contains("filter-pill")) {
      document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
      e.target.classList.add("active");
      state.logFilterLevel = e.target.getAttribute("data-level");
      renderLogEntries();
    }
  });

  DOM.logSearchInput.addEventListener("input", (e) => {
    state.logSearchQuery = e.target.value.toLowerCase().trim();
    renderLogEntries();
  });

  DOM.btnDownloadLog.addEventListener("click", downloadLogFile);

  // Interactive Chart Hover Tooltip
  setupChartHover();
}

// ==========================================================================
// Theme & Presentation Mode
// ==========================================================================
function applyTheme(theme) {
  if (theme === "light") {
    document.body.classList.remove("dark-theme");
    document.body.classList.add("light-theme");
    DOM.themeIconMoon.classList.add("hidden");
    DOM.themeIconSun.classList.remove("hidden");
  } else {
    document.body.classList.remove("light-theme");
    document.body.classList.add("dark-theme");
    DOM.themeIconMoon.classList.remove("hidden");
    DOM.themeIconSun.classList.add("hidden");
  }
}

function togglePresentationMode() {
  state.presentationMode = !state.presentationMode;
  document.body.classList.toggle("presentation-mode", state.presentationMode);
  DOM.exitPresBtn.classList.toggle("hidden", !state.presentationMode);

  setTimeout(() => {
    setupCanvasHiDPI();
    renderTimelineChart();
    renderSparklines();
  }, 100);
}

function openDrawer(drawer) {
  drawer.classList.remove("hidden");
}

function closeDrawer(drawer) {
  drawer.classList.add("hidden");
}

function openModal(modal) {
  modal.classList.remove("hidden");
}

function closeModal(modal) {
  modal.classList.add("hidden");
}

function closeAllDrawers() {
  closeDrawer(DOM.demoDrawer);
  closeDrawer(DOM.settingsDrawer);
  closeModal(DOM.logModal);
}

// ==========================================================================
// Canvas High-DPI Scaling Setup
// ==========================================================================
function setupCanvasHiDPI() {
  const dpr = window.devicePixelRatio || 1;
  const canvases = [DOM.timelineCanvas, DOM.cpuSparklineCanvas, DOM.memSparklineCanvas];

  canvases.forEach((c) => {
    if (!c) return;
    const rect = c.getBoundingClientRect();
    if (rect.width === 0) return;
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    ctx.resetTransform?.();
    ctx.scale(dpr, dpr);
  });
}

// ==========================================================================
// API Polling: /api/state
// ==========================================================================
async function pollState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.connected = true;
    DOM.serverOfflineBanner.classList.add("hidden");

    handleStateUpdate(data);
  } catch (err) {
    state.connected = false;
    DOM.serverOfflineBanner.classList.remove("hidden");
    updateConnectionBadge("Server offline", "offline");
    updateModeBadge("STOPPED", "stopped");
  }
}

function handleStateUpdate(data) {
  state.lastState = data;
  state.managerRunning = Boolean(data.running);
  state.isStale = Boolean(data.stale);

  // Missing or stopped state
  if (data.missing || !state.managerRunning) {
    DOM.emptyStateScreen.classList.remove("hidden");
    updateModeBadge("STOPPED", "stopped");
    updateConnectionBadge(data.missing ? "Waiting for manager" : "Manager stopped", data.missing ? "waiting" : "stopped");
    return;
  }

  // Manager is running
  DOM.emptyStateScreen.classList.add("hidden");

  // Mode & Connection Badges
  if (state.isStale) {
    updateModeBadge("STALE", "stale");
    updateConnectionBadge(`Stale (${data.age_sec || 0}s old)`, "offline");
  } else {
    const mode = (data.mode || "LIVE").toUpperCase();
    if (mode === "DRY-RUN") {
      updateModeBadge("DRY-RUN", "dry-run");
    } else {
      updateModeBadge("LIVE", "live");
    }
    updateConnectionBadge("Connected", "connected");
  }

  // Header Metrics
  if (data.uptime_sec !== undefined) {
    DOM.uptimeVal.textContent = formatUptime(data.uptime_sec);
  }
  const sys = data.system || {};
  DOM.procsCountVal.textContent = sys.process_count || (data.processes ? data.processes.length : "--");
  if (sys.load && sys.load.length >= 3) {
    DOM.loadVal.textContent = sys.load.map((n) => Number(n).toFixed(2)).join(", ");
  }
  if (data.cores) {
    DOM.coresBadge.textContent = `${data.cores} Cores`;
  }

  // Hero KPIs
  const cpuPct = Number(sys.cpu_pct || 0);
  const memPct = Number(sys.mem_pct || 0);
  updateRadialGauge(DOM.cpuGaugeCircle, DOM.cpuPctVal, cpuPct);
  updateRadialGauge(DOM.memGaugeCircle, DOM.memPctVal, memPct);

  // Free/Total memory
  if (sys.mem_free_mb !== undefined && sys.mem_total_mb !== undefined) {
    DOM.memFreeText.textContent = `${Number(sys.mem_free_mb).toLocaleString()} MB Free`;
    DOM.memTotalText.textContent = `${Number(sys.mem_total_mb).toLocaleString()} MB Total`;
  }

  // Sparkline history ring buffers (max 120 samples)
  state.cpuSparklineHistory.push(cpuPct);
  if (state.cpuSparklineHistory.length > 120) state.cpuSparklineHistory.shift();

  state.memSparklineHistory.push(memPct);
  if (state.memSparklineHistory.length > 120) state.memSparklineHistory.shift();

  const peakCpu = Math.max(...state.cpuSparklineHistory, 0);
  DOM.cpuPeakVal.textContent = `Peak: ${peakCpu.toFixed(1)}%`;

  renderSparklines();

  // Action Totals
  if (data.totals) {
    updateCounters(data.totals);
  }

  // Rules Ladder
  if (data.rules) {
    state.rules = data.rules;
    updateLadderRules(data.rules);
  }

  // Events & Action Feed
  const newActions = [];
  if (Array.isArray(data.events)) {
    processEvents(data.events, newActions);
  }

  // Timeline History with Action Markers (max 180 samples = 3 mins)
  state.timelineHistory.push({
    time: data.timestamp || new Date().toISOString(),
    cpu: cpuPct,
    mem: memPct,
    markers: newActions,
  });
  if (state.timelineHistory.length > 180) state.timelineHistory.shift();
  renderTimelineChart();

  // Process Table
  if (Array.isArray(data.processes)) {
    renderProcessTable(data.processes);
  }
}

// ==========================================================================
// Mode & Connection Badge Helpers
// ==========================================================================
function updateModeBadge(text, className) {
  DOM.modeBadge.className = `badge mode-badge ${className}`;
  DOM.modeBadge.querySelector(".badge-label").textContent = text;
}

function updateConnectionBadge(text, className) {
  DOM.connBadge.className = `badge conn-badge ${className}`;
  DOM.connBadge.querySelector(".badge-label").textContent = text;
}

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// ==========================================================================
// Hero Radial Gauges (Animated SVG Circular Stroke)
// ==========================================================================
function updateRadialGauge(circleElem, textElem, pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  const radius = 68;
  const circumference = 2 * Math.PI * radius; // ~427.26

  const offset = circumference * (1 - clamped / 100);
  circleElem.style.strokeDasharray = `${circumference}`;
  circleElem.style.strokeDashoffset = `${offset}`;

  // Threshold coloring
  if (clamped < 50) {
    circleElem.style.stroke = "var(--color-ok)";
  } else if (clamped < 80) {
    circleElem.style.stroke = "var(--color-warn)";
  } else {
    circleElem.style.stroke = "var(--color-kill)";
  }

  textElem.textContent = clamped.toFixed(1);
}

// ==========================================================================
// Sparkline Renderer (Canvas)
// ==========================================================================
function renderSparklines() {
  drawSparkline(DOM.cpuSparklineCanvas, state.cpuSparklineHistory, "var(--accent-cyan)", "rgba(6, 182, 212, 0.2)");
  drawSparkline(DOM.memSparklineCanvas, state.memSparklineHistory, "var(--accent-violet)", "rgba(139, 92, 246, 0.2)");
}

function drawSparkline(canvas, data, strokeColor, fillColor) {
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const maxVal = 100;
  const step = w / (data.length - 1);

  ctx.beginPath();
  data.forEach((val, i) => {
    const x = i * step;
    const y = h - (val / maxVal) * (h - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  // Stroke
  ctx.strokeStyle = strokeColor.startsWith("var") ? getComputedStyle(document.body).getPropertyValue(strokeColor.slice(4, -1)).trim() : strokeColor;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // Gradient Area Fill
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

// ==========================================================================
// Action Totals Counter Animation
// ==========================================================================
function updateCounters(totals) {
  animateCounter(DOM.counterWarn, state.prevTotals.warn, totals.warn || 0);
  animateCounter(DOM.counterRenice, state.prevTotals.renice, totals.renice || 0);
  animateCounter(DOM.counterPause, state.prevTotals.pause, totals.pause || 0);
  animateCounter(DOM.counterKill, state.prevTotals.kill, totals.kill || 0);

  state.prevTotals = { ...totals };
}

function animateCounter(element, start, end) {
  if (start === end) {
    element.textContent = end;
    return;
  }
  element.style.transform = "scale(1.25)";
  const duration = 400;
  const startTime = performance.now();

  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const current = Math.floor(start + (end - start) * progress);
    element.textContent = current;
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      element.textContent = end;
      element.style.transform = "scale(1)";
    }
  }
  requestAnimationFrame(step);
}

// ==========================================================================
// Timeline Area Chart & Action Markers (Canvas)
// ==========================================================================
function renderTimelineChart() {
  const canvas = DOM.timelineCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const data = state.timelineHistory;
  if (data.length < 2) return;

  const padLeft = 32;
  const padRight = 16;
  const padTop = 20;
  const padBottom = 22;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  // Background Grid Lines
  ctx.strokeStyle = state.theme === "light" ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  [0, 25, 50, 75, 100].forEach((pct) => {
    const y = padTop + plotH - (pct / 100) * plotH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();

    ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
    ctx.font = "9px monospace";
    ctx.fillText(`${pct}%`, 4, y + 3);
  });

  const step = plotW / (data.length - 1);

  // Helper to draw filled area and line
  function drawSeries(key, strokeColor, fillColor) {
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padLeft + i * step;
      const y = padTop + plotH - (d[key] / 100) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill area
    ctx.lineTo(padLeft + (data.length - 1) * step, padTop + plotH);
    ctx.lineTo(padLeft, padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // Draw Memory area then CPU area
  const memGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  memGrad.addColorStop(0, "rgba(139, 92, 246, 0.35)");
  memGrad.addColorStop(1, "rgba(139, 92, 246, 0.01)");
  drawSeries("mem", "#8b5cf6", memGrad);

  const cpuGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  cpuGrad.addColorStop(0, "rgba(6, 182, 212, 0.45)");
  cpuGrad.addColorStop(1, "rgba(6, 182, 212, 0.02)");
  drawSeries("cpu", "#06b6d4", cpuGrad);

  // Draw Vertical Action Markers (RENICE, PAUSE, KILL, CONFIG)
  data.forEach((d, i) => {
    if (!d.markers || d.markers.length === 0) return;
    const x = padLeft + i * step;

    d.markers.forEach((m, idx) => {
      let markerColor = "#06b6d4";
      if (m.level === "PAUSE") markerColor = "#f97316";
      else if (m.level === "KILL") markerColor = "#ef4444";
      else if (m.level === "KILL-9") markerColor = "#b91c1c";
      else if (m.level === "CONFIG") markerColor = "#a855f7";
      else if (m.level === "WARN") markerColor = "#f59e0b";

      // Dashed vertical line
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = markerColor;
      ctx.lineWidth = 1.5;
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // Marker Pill / Dot at top
      ctx.fillStyle = markerColor;
      ctx.beginPath();
      ctx.arc(x, padTop + 4 + (idx * 14), 4, 0, Math.PI * 2);
      ctx.fill();

      // Text label
      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px sans-serif";
      ctx.fillText(m.level, x + 6, padTop + 7 + (idx * 14));
    });
  });
}

// Chart Hover Interaction
function setupChartHover() {
  const container = DOM.chartContainer;
  const tooltip = DOM.chartTooltip;

  container.addEventListener("mousemove", (e) => {
    const data = state.timelineHistory;
    if (data.length < 2) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const padLeft = 32;
    const padRight = 16;
    const plotW = rect.width - padLeft - padRight;

    if (mouseX < padLeft || mouseX > rect.width - padRight) {
      tooltip.classList.add("hidden");
      return;
    }

    const step = plotW / (data.length - 1);
    const index = Math.round((mouseX - padLeft) / step);
    const point = data[Math.min(data.length - 1, Math.max(0, index))];

    if (!point) return;

    const timeStr = point.time.includes("T") ? point.time.split("T")[1].slice(0, 8) : point.time.slice(11, 19);
    let markerHtml = "";
    if (point.markers && point.markers.length > 0) {
      markerHtml = point.markers.map((m) => `<div style="color:var(--color-${m.level.toLowerCase()});font-weight:700;">★ ${m.level}: ${escapeHtml(m.message)}</div>`).join("");
    }

    tooltip.innerHTML = `
      <div style="font-weight:700;color:var(--text-muted);">${timeStr}</div>
      <div>CPU: <strong style="color:var(--accent-cyan);">${point.cpu.toFixed(1)}%</strong></div>
      <div>RAM: <strong style="color:var(--accent-violet);">${point.mem.toFixed(1)}%</strong></div>
      ${markerHtml}
    `;

    tooltip.style.left = `${mouseX}px`;
    tooltip.style.top = `60px`;
    tooltip.classList.remove("hidden");
  });

  container.addEventListener("mouseleave", () => {
    tooltip.classList.add("hidden");
  });
}

// ==========================================================================
// Event Processing & Live Action Feed
// ==========================================================================
function processEvents(events, newActionsOut) {
  events.forEach((ev) => {
    const key = `${ev.time}_${ev.level}_${ev.message}`;
    if (!state.knownEventKeys.has(key)) {
      state.knownEventKeys.add(key);
      state.feedEvents.unshift(ev);
      if (state.feedEvents.length > 50) state.feedEvents.pop();

      // Action marker for chart
      if (["WARN", "RENICE", "PAUSE", "KILL", "KILL-9", "CONFIG"].includes(ev.level)) {
        newActionsOut.push(ev);
      }

      // Toast notification for critical escalations
      if (["PAUSE", "KILL", "KILL-9", "CONFIG"].includes(ev.level)) {
        showToast(ev.level, ev.message);
      }

      renderFeedItem(ev, true);
    }
  });

  DOM.feedCountBadge.textContent = `${state.feedEvents.length} events`;
}

function renderFeedItem(ev, prepend = false) {
  const container = DOM.feedContainer;
  const empty = container.querySelector(".feed-empty-notice");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = `feed-item level-${ev.level}`;

  let iconText = "ℹ";
  if (ev.level === "WARN") iconText = "⚠";
  else if (ev.level === "RENICE") iconText = "⬇";
  else if (ev.level === "PAUSE") iconText = "⏸";
  else if (ev.level === "KILL") iconText = "✕";
  else if (ev.level === "KILL-9") iconText = "⚡";
  else if (ev.level === "CONFIG") iconText = "⚙";

  const timeOnly = ev.time ? ev.time.split(" ")[1] || ev.time : "";

  item.innerHTML = `
    <div class="feed-level-icon">${iconText}</div>
    <div class="feed-content">
      <div class="feed-top-line">
        <span class="feed-badge">${ev.level}</span>
        <span class="feed-time mono">${timeOnly}</span>
      </div>
      <div class="feed-msg">${escapeHtml(ev.message)}</div>
    </div>
  `;

  if (prepend && container.firstChild) {
    container.insertBefore(item, container.firstChild);
  } else {
    container.appendChild(item);
  }
}

// Toast System
function showToast(level, message) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${level.toLowerCase()}`;

  let icon = "⚙";
  if (level === "PAUSE") icon = "⏸";
  else if (level === "KILL") icon = "✕";
  else if (level === "KILL-9") icon = "⚡";

  toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <span class="toast-text"><strong>${level}:</strong> ${escapeHtml(message)}</span>
  `;

  DOM.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(40px)";
    setTimeout(() => toast.remove(), 350);
  }, 4500);
}

// ==========================================================================
// Process Table
// ==========================================================================
function renderProcessTable(processes) {
  let list = [...processes];

  // Filtering
  if (state.filterQuery) {
    list = list.filter((p) => {
      const q = state.filterQuery;
      return (
        String(p.pid).includes(q) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.status && p.status.toLowerCase().includes(q))
      );
    });
  }

  // Sorting
  list.sort((a, b) => {
    let valA = a[state.sortCol];
    let valB = b[state.sortCol];

    if (valA === undefined) valA = 0;
    if (valB === undefined) valB = 0;

    if (typeof valA === "string") valA = valA.toLowerCase();
    if (typeof valB === "string") valB = valB.toLowerCase();

    if (valA < valB) return state.sortAsc ? -1 : 1;
    if (valA > valB) return state.sortAsc ? 1 : -1;
    return 0;
  });

  const tbody = DOM.procTableBody;
  tbody.innerHTML = "";

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-muted);">No matching processes found</td></tr>`;
    return;
  }

  list.forEach((proc) => {
    const row = document.createElement("tr");
    row.className = `proc-row`;

    // Row styling based on status
    if (proc.status === "paused") row.classList.add("row-paused");
    if (proc.status === "killed") row.classList.add("row-killed");

    // Flash animation if status changed
    const prevStatus = state.procStatusCache.get(proc.pid);
    if (prevStatus && prevStatus !== proc.status) {
      row.classList.add("flash-status");
    }
    state.procStatusCache.set(proc.pid, proc.status);

    // State Chip
    const stateLetter = (proc.state || "S").toUpperCase();
    const stateTooltip = getStateTooltip(stateLetter);

    // Inline CPU bar percentage (clamp to 100 for bar width)
    const cpuVal = Number(proc.cpu_pct || 0);
    const barWidth = Math.min(100, Math.max(0, cpuVal));
    let fillClass = "";
    if (cpuVal > 70) fillClass = "danger";
    else if (cpuVal > 35) fillClass = "warn";

    // Status Pill
    const statusVal = (proc.status || "ok").toLowerCase();
    let statusIcon = "•";
    if (statusVal === "protected") statusIcon = "🛡";

    row.innerHTML = `
      <td class="mono"><strong>${proc.pid}</strong></td>
      <td><strong>${escapeHtml(proc.name || "unknown")}</strong></td>
      <td>
        <span class="state-chip state-${stateLetter}" title="${stateTooltip}">${stateLetter}</span>
      </td>
      <td class="mono">${proc.nice !== undefined ? proc.nice : 0}</td>
      <td>
        <div class="cpu-bar-cell">
          <div class="cpu-track"><div class="cpu-fill ${fillClass}" style="width:${barWidth}%;"></div></div>
          <span class="mono">${cpuVal.toFixed(1)}%</span>
        </div>
      </td>
      <td class="mono">${proc.mem_mb !== undefined ? Number(proc.mem_mb).toFixed(1) : 0.0} MB</td>
      <td>
        <span class="status-pill ${statusVal}">
          <span>${statusIcon}</span> ${statusVal}
        </span>
      </td>
    `;

    tbody.appendChild(row);
  });
}

function getStateTooltip(letter) {
  switch (letter) {
    case "R": return "Running or runnable on CPU runqueue";
    case "S": return "Interruptible sleep (waiting for event/IO)";
    case "T": return "Stopped by signal (SIGSTOP) / job control";
    case "Z": return "Zombie / Defunct (terminated, pending waitpid)";
    case "I": return "Idle kernel thread";
    default: return "Process state";
  }
}

function updateSortHeaderUI() {
  document.querySelectorAll(".proc-table th.sortable").forEach((th) => {
    const col = th.getAttribute("data-sort");
    const indicator = th.querySelector(".sort-indicator");
    if (col === state.sortCol) {
      th.classList.add(state.sortAsc ? "sorted-asc" : "sorted-desc");
      indicator.textContent = state.sortAsc ? "▲" : "▼";
    } else {
      th.classList.remove("sorted-asc", "sorted-desc");
      indicator.textContent = "";
    }
  });
  DOM.tableSubtitle.textContent = `Sorted by ${state.sortCol} (${state.sortAsc ? "Ascending" : "Descending"})`;
}

// ==========================================================================
// "How It Works" Escalation Ladder
// ==========================================================================
function updateLadderRules(rules) {
  if (rules.mem_limit_mb !== undefined) DOM.ladderMemLimit.textContent = rules.mem_limit_mb;
  if (rules.cpu_limit !== undefined) DOM.ladderCpuLimit.textContent = rules.cpu_limit;
  if (rules.t_renice !== undefined) DOM.ladderTRenice.textContent = rules.t_renice;
  if (rules.t_kill !== undefined) DOM.ladderTKill.textContent = rules.t_kill;
  if (rules.leak_secs !== undefined) DOM.ladderLeakSecs.textContent = rules.leak_secs;
  if (rules.nice_value !== undefined) DOM.ladderNiceVal.textContent = rules.nice_value;
  if (rules.grace_cycles !== undefined) DOM.ladderGraceCycles.textContent = rules.grace_cycles;
}

// ==========================================================================
// Settings Drawer & manager.conf Management
// ==========================================================================
async function fetchInitialConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = await res.json();

    DOM.cfgDryRun.checked = Boolean(cfg.dry_run);
    DOM.cfgCpuLimit.value = cfg.cpu_limit || 70;
    DOM.cfgCpuLimitVal.textContent = `${cfg.cpu_limit}%`;
    DOM.cfgMemLimit.value = cfg.mem_limit_mb || 500;
    DOM.cfgMemLimitVal.textContent = `${cfg.mem_limit_mb} MB`;
    DOM.cfgTRenice.value = cfg.t_renice || 5;
    DOM.cfgTReniceVal.textContent = `${cfg.t_renice}s`;
    DOM.cfgTKill.value = cfg.t_kill || 10;
    DOM.cfgTKillVal.textContent = `${cfg.t_kill}s`;
    DOM.cfgLeakSecs.value = cfg.leak_secs || 10;
    DOM.cfgLeakSecsVal.textContent = `${cfg.leak_secs}s`;
    DOM.cfgNiceValue.value = cfg.nice_value || 10;
    DOM.cfgNiceValueVal.textContent = cfg.nice_value;
    DOM.cfgGraceCycles.value = cfg.grace_cycles || 3;
    DOM.cfgGraceCyclesVal.textContent = cfg.grace_cycles;
    DOM.cfgTableRows.value = cfg.table_rows || 10;
    DOM.cfgTableRowsVal.textContent = cfg.table_rows;

    const prot = cfg.protected || "systemd, init, sshd, bash, zsh, sh, node, MainThread, SessionLeader";
    state.protectedList = prot.split(",").map((s) => s.trim()).filter(Boolean);
    renderProtectedChips();
  } catch (err) {
    console.warn("Failed fetching config:", err);
  }
}

function bindSliderSync(slider, label, suffix = "") {
  slider.addEventListener("input", () => {
    label.textContent = `${slider.value}${suffix}`;
  });
}

function renderProtectedChips() {
  const container = DOM.protectedChips;
  container.innerHTML = "";
  state.protectedList.forEach((name, idx) => {
    const chip = document.createElement("span");
    chip.className = "proc-chip";
    chip.innerHTML = `
      ${escapeHtml(name)}
      <button type="button" class="chip-remove" data-idx="${idx}">&times;</button>
    `;
    chip.querySelector(".chip-remove").addEventListener("click", () => {
      state.protectedList.splice(idx, 1);
      renderProtectedChips();
    });
    container.appendChild(chip);
  });
}

function addProtectedChip() {
  const val = DOM.addProtectedInput.value.trim();
  if (val && !state.protectedList.includes(val)) {
    state.protectedList.push(val);
    renderProtectedChips();
    DOM.addProtectedInput.value = "";
  }
}

async function saveConfigForm(e) {
  e.preventDefault();
  DOM.saveStatusMsg.textContent = "Saving...";
  DOM.btnSaveConfig.disabled = true;

  const t_renice = parseInt(DOM.cfgTRenice.value, 10);
  const t_kill = parseInt(DOM.cfgTKill.value, 10);
  if (t_kill < t_renice) {
    DOM.saveStatusMsg.textContent = "Error: Time to Kill must be >= Time to Renice";
    DOM.btnSaveConfig.disabled = false;
    return;
  }

  const payload = {
    dry_run: DOM.cfgDryRun.checked ? 1 : 0,
    cpu_limit: parseFloat(DOM.cfgCpuLimit.value),
    mem_limit_mb: parseFloat(DOM.cfgMemLimit.value),
    t_renice: t_renice,
    t_kill: t_kill,
    leak_secs: parseInt(DOM.cfgLeakSecs.value, 10),
    nice_value: parseInt(DOM.cfgNiceValue.value, 10),
    grace_cycles: parseInt(DOM.cfgGraceCycles.value, 10),
    table_rows: parseInt(DOM.cfgTableRows.value, 10),
    protected: state.protectedList.join(", "),
  };

  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Failed to save configuration");
    }

    DOM.saveStatusMsg.textContent = "Saved & Applied!";
    showToast("CONFIG", data.message || "Rules saved to manager.conf");
    setTimeout(() => {
      DOM.saveStatusMsg.textContent = "";
      closeDrawer(DOM.settingsDrawer);
    }, 1200);
  } catch (err) {
    DOM.saveStatusMsg.textContent = `Error: ${err.message}`;
    showToast("WARN", err.message);
  } finally {
    DOM.btnSaveConfig.disabled = false;
  }
}

// ==========================================================================
// Demo Controls
// ==========================================================================
async function triggerDemoStart(kind) {
  try {
    const res = await fetch("/api/demo/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to start demo workload");
    showToast("INFO", `Started ${kind} process (PID ${data.pid})`);
    fetchDemoStatus();
  } catch (err) {
    showToast("WARN", err.message);
  }
}

async function triggerDemoStop() {
  try {
    const res = await fetch("/api/demo/stop", { method: "POST" });
    const data = await res.json();
    showToast("INFO", data.message || "Stopped demo processes");
    fetchDemoStatus();
  } catch (err) {
    showToast("WARN", err.message);
  }
}

async function fetchDemoStatus() {
  try {
    const res = await fetch("/api/demo");
    if (!res.ok) return;
    const data = await res.json();
    const container = DOM.activeDemosList;
    if (data.running && data.running.length > 0) {
      container.innerHTML = data.running
        .map(
          (p) =>
            `<span class="demo-chip"><span>●</span> PID ${p.pid} (${p.name || p.kind}) - ${p.status || "active"}</span>`
        )
        .join("");
    } else {
      container.innerHTML = `<span class="text-muted">No test processes currently running</span>`;
    }
  } catch (err) {
    console.warn("Error fetching demo status:", err);
  }
}

// ==========================================================================
// Log Viewer Modal
// ==========================================================================
async function fetchLogs() {
  try {
    const res = await fetch("/api/log?lines=200");
    if (!res.ok) return;
    state.logLines = await res.json();
    renderLogEntries();
  } catch (err) {
    console.warn("Failed fetching log lines:", err);
  }
}

function renderLogEntries() {
  const container = DOM.logViewerBody;
  let lines = [...state.logLines];

  if (state.logFilterLevel !== "ALL") {
    lines = lines.filter((l) => l.level === state.logFilterLevel);
  }

  if (state.logSearchQuery) {
    const q = state.logSearchQuery;
    lines = lines.filter(
      (l) =>
        (l.message && l.message.toLowerCase().includes(q)) ||
        (l.time && l.time.includes(q)) ||
        (l.level && l.level.toLowerCase().includes(q))
    );
  }

  if (lines.length === 0) {
    container.innerHTML = `<div class="log-empty-msg">No log entries found matching criteria.</div>`;
    return;
  }

  container.innerHTML = lines
    .map(
      (l) => `
      <div class="log-line">
        <span class="log-time">${l.time || "--:--:--"}</span>
        <span class="log-level ${l.level}">[${l.level}]</span>
        <span class="log-msg">${escapeHtml(l.message)}</span>
      </div>
    `
    )
    .join("");

  if (DOM.logAutoscrollChk.checked) {
    container.scrollTop = container.scrollHeight;
  }
}

function downloadLogFile() {
  const text = state.logLines
    .map((l) => `${l.time} [${l.level}] ${l.message}`)
    .join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `smart_rm_${new Date().toISOString().slice(0, 10)}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ==========================================================================
// Utility Helpers
// ==========================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Start application
document.addEventListener("DOMContentLoaded", init);
