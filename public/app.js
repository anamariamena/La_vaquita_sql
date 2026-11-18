const TITLES = {
  dashboard: "Resumen",
  inventory: "Inventario",
  sales: "Ventas",
  "sales-history": "Historial de ventas",
  products: "Productos",
  finances: "Finanzas",
  "sql-console": "Consola SQL"
};
const PAYMENT_TYPES = ["Efectivo", "Débito", "Crédito", "Transferencia", "Otro"];
const MOVEMENT_TYPES = [
  { value: "entry", label: "Entrada de compra" },
  { value: "adjustment", label: "Ajuste de inventario" },
  { value: "return", label: "Devolución de cliente" },
  { value: "supplier_return", label: "Devolución a proveedor" },
  { value: "loss", label: "Merma / pérdida" }
];
const currency = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0
});
const quantityFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 3 });
const dateFormatter = new Intl.DateTimeFormat("es-CL", {
  day: "2-digit",
  month: "short",
  year: "numeric"
});

let SQL;
let db;
let journalMode = "memory";
let fileHandle = null;
let filename = "la-vaquita.db";
let currentView = "dashboard";
let dashboardRange = "week";
let financeRange = 3;
let autoSaveEnabled = false;
let autoSavePending = false;
let autoSaveInFlight = false;
let autoSaveRequest = null;
let autoSaveTimer;
let saleCart = [];
let paymentRows = [{ type: "Efectivo", amount: "" }];
let saleCustomerId = "";
let saleDiscount = "0";
let saleDocumentType = "BOLETA";
let saleFolio = "";
let editingSaleId = null;
let customerHistoryId = null;
let searchValue = "";
let sqlConsoleInput = "";
let sqlConsoleOutput = null;
let barcodeBuffer = "";
let barcodeLastKeyTime = 0;
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const money = (amount) => currency.format(Number(amount) || 0);
const quantityLabel = (amount, unit = "UN") => `${quantityFormatter.format(Number(amount) || 0)} ${unit}`;
const localDateTime = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19).replace("T", " ");
};
const dateLabel = (value) => value ? dateFormatter.format(new Date(String(value).replace(" ", "T"))) : "—";

function query(sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function run(sql, params = []) {
  if (params.length) db.run(sql, params);
  else db.run(sql);
  scheduleAutoSave();
}

function scalar(sql, params = []) {
  return query(sql, params)[0]?.value ?? 0;
}

function notify(message, type = "success") {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast ${type === "error" ? "error" : ""}" role="status">${escapeHtml(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ""; }, 3600);
}

function showError(error, fallback) {
  console.error(error);
  notify(error instanceof Error ? error.message : fallback, "error");
}

function databaseReady() {
  return Boolean(db);
}

function scheduleAutoSave() {
  if (!databaseReady() || !autoSaveEnabled) return;
  autoSavePending = true;
  clearTimeout(autoSaveTimer);
  $("#autosave-status").textContent = "Guardando automáticamente…";
  autoSaveTimer = setTimeout(flushAutoSave, 400);
}

async function saveServerDatabase(bytes) {
  const response = await fetch("/api/database", {
    method: "PUT",
    headers: { "Content-Type": "application/vnd.sqlite3" },
    body: bytes
  });
  if (!response.ok) throw new Error(`El servidor respondió ${response.status}.`);
}

async function flushAutoSave() {
  if (autoSaveRequest) {
    const saved = await autoSaveRequest;
    if (!saved) return false;
    return autoSavePending ? flushAutoSave() : true;
  }
  if (!autoSavePending || !databaseReady()) return true;
  autoSavePending = false;
  autoSaveInFlight = true;
  autoSaveRequest = (async () => {
    try {
      const bytes = db.export();
      if (fileHandle) {
        try {
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          try {
            await saveServerDatabase(bytes);
          } catch (backupError) {
            console.error("Fallaron el guardado del archivo y la copia del servidor:", backupError);
            throw new Error(`No se pudo guardar en el archivo ni en el servidor local: ${error.message}`);
          }
          throw new Error(`No se pudo guardar en el archivo seleccionado. Se conservó una copia en el servidor local. ${error.message}`);
        }
        $("#autosave-status").textContent = "Guardado automáticamente en el archivo";
        try {
          await saveServerDatabase(bytes);
        } catch (error) {
          console.error("La base se guardó en el archivo, pero falló la copia del servidor:", error);
          notify("Datos guardados en el archivo; no se pudo actualizar la copia del servidor.", "error");
        }
      } else {
        await saveServerDatabase(bytes);
        $("#autosave-status").textContent = "Guardado automáticamente en el servidor local";
      }
      return true;
    } catch (error) {
      $("#autosave-status").textContent = "Error al guardar";
      showError(error, fileHandle
        ? "No se pudo guardar automáticamente en el archivo seleccionado."
        : "No se pudieron guardar automáticamente los datos en el servidor local.");
      return false;
    } finally {
      autoSaveInFlight = false;
      autoSaveRequest = null;
      if (autoSavePending) autoSaveTimer = setTimeout(flushAutoSave, 100);
    }
  })();
  return autoSaveRequest;
}

async function initializeSql() {
  if (!SQL) SQL = await initSqlJs({ locateFile: (file) => `/vendor/${file}` });
}

async function openApplication(database, name, handle = null, saveOnOpen = true) {
  const previousDb = db;
  db = database;
  try {
    const configuration = await DatabaseLayer.initialize(database);
    journalMode = configuration.journalMode;
  } catch (error) {
    db = previousDb;
    database.close();
    throw error;
  }
  if (previousDb && previousDb !== database) previousDb.close();
  fileHandle = handle;
  filename = name || "la-vaquita.db";
  autoSaveEnabled = true;
  $("#welcome").classList.add("hidden");
  $("#application").classList.remove("hidden");
  $("#sidebar-db-name").textContent = filename;
  $("#today-label").textContent = new Intl.DateTimeFormat("es-CL", {
    weekday: "short", day: "numeric", month: "short"
  }).format(new Date());
  currentView = "dashboard";
  saleCart = [];
  paymentRows = [{ type: "Efectivo", amount: "" }];
  saleCustomerId = "";
  saleDiscount = "0";
  saleDocumentType = "BOLETA";
  saleFolio = "";
  editingSaleId = null;
  render();
  if (saveOnOpen) scheduleAutoSave();
  if (journalMode.toLowerCase() !== "wal") {
    notify(`SQLite no habilitó WAL (modo ${journalMode}); guarda o descarga el archivo para conservar los cambios.`, "error");
  }
}

function setLoading(button, loading) {
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
}

async function openFilePicker() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: "Base de datos SQLite",
          accept: { "application/vnd.sqlite3": [".db", ".sqlite", ".sqlite3"] }
        }]
      });
      let writePermission = await handle.queryPermission({ mode: "readwrite" });
      if (writePermission !== "granted") {
        writePermission = await handle.requestPermission({ mode: "readwrite" });
      }
      const file = await handle.getFile();
      await openDatabaseBytes(await file.arrayBuffer(), file.name, writePermission === "granted" ? handle : null);
      if (writePermission !== "granted") {
        notify("No se concedió permiso de escritura. Los cambios se guardarán en el servidor local, no en este archivo.", "error");
      }
    } catch (error) {
      if (error.name !== "AbortError") showError(error, "No se pudo abrir la base de datos.");
    }
    return;
  }
  $("#database-file").click();
}

async function openDatabaseBytes(buffer, name, handle = null) {
  try {
    await initializeSql();
    const database = new SQL.Database(new Uint8Array(buffer));
    await openApplication(database, name, handle);
    if (!handle) {
      notify("Este navegador no permite sobrescribir el archivo abierto. Los cambios se guardarán en el servidor local; usa Guardar / descargar para actualizar el archivo.", "error");
    }
    notify(`Base de datos «${name}» lista.`);
  } catch (error) {
    showError(error, "No se pudo abrir esta base de datos SQLite.");
  }
}

async function createDatabase() {
  try {
    await initializeSql();
    const database = new SQL.Database();
    try {
      await DatabaseLayer.initialize(database);
      const bytes = database.export();
      const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "la-vaquita.db";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Archivo «la-vaquita.db» vacío descargado. Usa «Abrir una existente» para seleccionarlo.");
    } finally {
      database.close();
    }
  } catch (error) {
    showError(error, "No se pudo crear la base de datos.");
  }
}

async function saveDatabase() {
  if (!databaseReady()) return;
  const bytes = db.export();
  const blob = new Blob([bytes], { type: "application/vnd.sqlite3" });
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      notify("Cambios guardados en el archivo seleccionado.");
      return;
    } catch (error) {
      showError(error, "No se pudo guardar sobre el archivo original. Prueba descargar una copia.");
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Base de datos descargada como «${filename}».`);
}

function render() {
  if (!databaseReady()) return;
  $("#page-title").textContent = TITLES[currentView];
  $(".nav-link.active")?.classList.remove("active");
  const navView = currentView === "sales-history" ? "sales" : currentView;
  $(`.nav-link[data-view="${navView}"]`)?.classList.add("active");
  const pages = {
    dashboard: renderDashboard,
    inventory: renderInventory,
    sales: renderSales,
    "sales-history": renderSalesHistory,
    products: renderProducts,
    finances: renderFinances,
    "sql-console": renderSqlConsole
  };
  $("#page-content").innerHTML = pages[currentView]();
}

function renderSqlConsole() {
  let output = `<p class="sql-console-placeholder">Los resultados de tus consultas aparecerán aquí.</p>`;
  if (sqlConsoleOutput?.error) {
    output = `<div class="sql-console-error" role="alert"><strong>No se pudo ejecutar el SQL.</strong><pre>${escapeHtml(sqlConsoleOutput.error)}</pre></div>`;
  } else if (sqlConsoleOutput) {
    const resultSets = sqlConsoleOutput.results;
    output = resultSets.length
      ? resultSets.map((result, index) => {
        const rows = result.values.slice(0, 200);
        const tableRows = rows.map((row) => `<tr>${row.map((value) => {
          const text = value === null ? "NULL" : value instanceof Uint8Array ? `BLOB (${value.length} bytes)` : String(value);
          return `<td>${escapeHtml(text)}</td>`;
        }).join("")}</tr>`).join("");
        return `<div class="sql-result-set"><div class="sql-result-heading">Resultado ${index + 1} · ${result.values.length} filas${result.values.length > rows.length ? " · mostrando las primeras 200" : ""}</div><div class="table-scroll"><table class="data-table sql-result-table"><thead><tr>${result.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table></div></div>`;
      }).join("")
      : `<p class="sql-console-placeholder">SQL ejecutado correctamente. No se devolvieron filas.</p>`;
  }
  return `${pageHeading("HERRAMIENTAS AVANZADAS", "Consola SQL", "Ejecuta consultas directamente sobre la base de datos abierta.")}
    <aside class="sql-console-warning" role="alert"><strong>Importante: realiza una copia de seguridad antes de usar esta consola.</strong><p>El SQL puede modificar o borrar datos y alterar la estructura de la base. No hay botón para deshacer y un error podría impedir que la aplicación vuelva a funcionar correctamente. Usa solo comandos que entiendas; los cambios se guardan automáticamente.</p></aside>
    <article class="panel sql-console-panel">
      <div class="panel-heading"><div><h2>Consulta SQL</h2><p>Usa Ctrl + Enter (o ⌘ + Enter) para ejecutar.</p></div></div>
      <div class="sql-console-controls"><textarea id="sql-console-input" class="sql-console-input" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Comando SQL" placeholder="SELECT name, stock FROM products LIMIT 20;">${escapeHtml(sqlConsoleInput)}</textarea>
        <div class="sql-console-actions"><button class="button button-muted button-small" type="button" data-action="clear-sql">Limpiar</button><button class="button button-primary button-small" type="button" data-action="run-sql">Ejecutar SQL</button></div>
      </div>
    </article>
    <article class="panel sql-console-output"><div class="panel-heading"><div><h2>Salida</h2></div></div><div class="sql-console-output-content">${output}</div></article>`;
}

function executeSqlConsole() {
  const sql = sqlConsoleInput.trim();
  if (!sql) {
    sqlConsoleOutput = { error: "Escribe una consulta SQL antes de ejecutarla." };
    render();
    return;
  }

  const candidate = new SQL.Database(db.export());
  try {
    candidate.run("PRAGMA foreign_keys = ON");
    candidate.run("SAVEPOINT sql_console_execution");
    const results = candidate.exec(sql);
    candidate.run("RELEASE sql_console_execution");
    const previousDb = db;
    db = candidate;
    previousDb.close();
    sqlConsoleOutput = { results };
    scheduleAutoSave();
  } catch (error) {
    candidate.close();
    sqlConsoleOutput = { error: error instanceof Error ? error.message : String(error) };
    showError(error, "No se pudo ejecutar el SQL.");
  }
  render();
}

async function exitToWelcome(button) {
  button.disabled = true;
  clearTimeout(autoSaveTimer);
  if (autoSaveEnabled) autoSavePending = true;
  if (autoSavePending && !(await flushAutoSave())) {
    button.disabled = false;
    return;
  }
  autoSaveEnabled = false;
  $("#application").classList.add("hidden");
  $("#welcome").classList.remove("hidden");
  button.disabled = false;
}

async function restoreAutoSavedDatabase() {
  try {
    const response = await fetch("/api/database", { cache: "no-store" });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`El servidor respondió ${response.status}.`);
    await initializeSql();
    const database = new SQL.Database(new Uint8Array(await response.arrayBuffer()));
    await openApplication(database, "la-vaquita.db", null, false);
  } catch (error) {
    showError(error, "No se pudo restaurar la base de datos guardada automáticamente.");
  }
}

function pageHeading(eyebrow, title, description, action = "") {
  return `<div class="page-heading"><div><span class="heading-eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-action">${action}</div>` : ""}</div>`;
}

function statCard(label, value, note, icon) {
  return `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon}</span></div><strong class="stat-value">${value}</strong><span class="stat-foot">${note}</span></article>`;
}

function emptyState(title, message) {
  return `<div class="empty-state"><b>${title}</b>${message}</div>`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function chartPeriods(range, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "week") {
    const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    return {
      unit: "day",
      first,
      previous: new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1),
      end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
      periods: Array.from({ length: 7 }, (_, index) => {
        const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + index);
        return {
          key: dateKey(date),
          label: new Intl.DateTimeFormat("es-CL", { weekday: "short" }).format(date).replace(".", "")
        };
      })
    };
  }
  if (range === "month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const periods = Array.from({ length: today.getDate() }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), index + 1);
      return { key: dateKey(date), label: String(index + 1) };
    });
    return {
      unit: "day",
      first,
      previous: new Date(first.getFullYear(), first.getMonth(), 0),
      end: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
      periods
    };
  }

  const count = range === "six" ? 6 : 13;
  const first = addMonths(today, -(count - 1));
  const firstMonth = addMonths(first, -1);
  const monthLabel = new Intl.DateTimeFormat("es-CL", { month: "short" });
  return {
    unit: "month",
    first,
    previous: firstMonth,
    end: addMonths(today, 1),
    periods: Array.from({ length: count }, (_, index) => {
      const date = addMonths(first, index);
      const label = monthLabel.format(date).replace(".", "");
      return {
        key: monthKey(date),
        label: range === "thirteen" ? `${label} ${String(date.getFullYear()).slice(-2)}` : label
      };
    })
  };
}

function shortMoney(amount) {
  const value = Number(amount) || 0;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toLocaleString("es-CL", { maximumFractionDigits: 1 })}M`;
  if (value >= 10_000) return `$${Math.round(value / 1_000).toLocaleString("es-CL")}k`;
  return money(value);
}

function dashboardChart() {
  const now = new Date();
  const range = chartPeriods(dashboardRange, now);
  const start = range.unit === "day" ? dateKey(range.previous) : monthKey(range.previous);
  const end = range.unit === "day" ? dateKey(range.end) : monthKey(range.end);
  const sales = query(
    "SELECT date,total FROM sales WHERE status='completed' AND date>=? AND date<?",
    [start, end]
  );
  const totals = new Map();
  for (const sale of sales) {
    const key = range.unit === "day" ? String(sale.date).slice(0, 10) : String(sale.date).slice(0, 7);
    totals.set(key, (totals.get(key) || 0) + Number(sale.total));
  }
  const previousKey = range.unit === "day" ? dateKey(range.previous) : monthKey(range.previous);
  const previousValue = totals.get(previousKey) || 0;
  const points = range.periods.map((period) => ({
    ...period,
    value: totals.get(period.key) || 0
  }));
  const values = points.map((point) => point.value);
  const max = Math.max(...values, previousValue, 1);
  const min = Math.min(...values, previousValue, 0);
  const span = max - min || 1;
  const left = 46;
  const right = 752;
  const top = 29;
  const bottom = 164;
  const x = (index) => left + (points.length <= 1 ? (right - left) / 2 : index * (right - left) / (points.length - 1));
  const y = (value) => bottom - ((value - min) / span) * (bottom - top);
  const grid = [0, 1, 2, 3].map((index) => {
    const amount = min + span * (3 - index) / 3;
    const lineY = top + index * (bottom - top) / 3;
    return `<line x1="${left}" y1="${lineY}" x2="${right}" y2="${lineY}" class="chart-gridline"/><text x="${left - 8}" y="${lineY + 3}" text-anchor="end" class="chart-text">${escapeHtml(shortMoney(amount))}</text>`;
  }).join("");
  const segmentLines = points.slice(1).map((point, index) => {
    const previous = index === 0 ? previousValue : points[index - 1].value;
    const trend = point.value > previous ? "positive" : point.value < previous ? "negative" : "neutral";
    return `<line x1="${x(index)}" y1="${y(points[index].value)}" x2="${x(index + 1)}" y2="${y(point.value)}" class="chart-segment chart-${trend}"/>`;
  }).join("");
  const circles = points.map((point, index) => {
    const previous = index === 0 ? previousValue : points[index - 1].value;
    const trend = point.value > previous ? "positive" : point.value < previous ? "negative" : "neutral";
    return `<circle cx="${x(index)}" cy="${y(point.value)}" r="3.5" class="chart-dot chart-${trend}"><title>${escapeHtml(point.label)}: ${escapeHtml(money(point.value))}</title></circle>`;
  }).join("");
  const labelStep = points.length > 20 ? Math.ceil(points.length / 10) : points.length > 8 ? 2 : 1;
  const labels = points.map((point, index) => {
    if (index % labelStep !== 0 && index !== points.length - 1) return "";
    return `<text x="${x(index)}" y="188" text-anchor="middle" class="chart-text">${escapeHtml(point.label)}</text>`;
  }).join("");
  const title = {
    week: "Ventas de los últimos 7 días",
    month: "Ventas de este mes",
    six: "Ventas de los últimos 6 meses",
    thirteen: "Ventas de los últimos 13 meses"
  }[dashboardRange];
  if (points.length === 1) {
    const trend = points[0].value > previousValue ? "positive" : points[0].value < previousValue ? "negative" : "neutral";
    return `<svg viewBox="0 0 780 205" role="img" aria-label="${title}">${grid}<circle cx="${x(0)}" cy="${y(points[0].value)}" r="4" class="chart-dot chart-${trend}"><title>${escapeHtml(points[0].label)}: ${escapeHtml(money(points[0].value))}</title></circle>${labels}</svg>`;
  }
  return `<svg viewBox="0 0 780 205" role="img" aria-label="${title}">${grid}${segmentLines}${circles}${labels}</svg>`;
}

function dashboardStockGroups() {
  const products = query("SELECT id,name,category,stock,min_stock,unit FROM products WHERE active=1 ORDER BY stock ASC,name");
  const groups = [
    { key: "critical", label: "Crítico", className: "critical", items: [] },
    { key: "low", label: "Bajo stock", className: "low", items: [] },
    { key: "suggestion", label: "Sugerencia", className: "suggestion", items: [] }
  ];
  for (const product of products) {
    const stock = Number(product.stock);
    const minimum = Number(product.min_stock);
    if (stock <= 0) groups[0].items.push(product);
    else if (stock <= minimum) groups[1].items.push(product);
    else if (minimum > 0 && stock <= minimum * 1.5) groups[2].items.push(product);
  }
  return groups;
}

function stockGroupMarkup(limit = 3) {
  const groups = dashboardStockGroups();
  return groups.map((group) => `<section class="stock-group stock-group-${group.className}">
    <div class="stock-group-heading"><span class="stock-state-dot"></span><b>${group.label}</b><span class="stock-group-count">${group.items.length}</span></div>
    ${group.items.length ? group.items.slice(0, limit).map((product) => `<div class="stock-row"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span class="stock-product"><b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.category || "Sin categoría")} · mín. ${quantityLabel(product.min_stock, product.unit)}</small></span><span class="stock-count">${quantityLabel(product.stock, product.unit)}</span><button class="button button-muted button-small stock-restock" data-action="restock-product" data-id="${product.id}">Reponer</button></div>`).join("") : `<p class="stock-group-empty">Sin productos en este nivel</p>`}
    ${group.items.length > limit ? `<button class="panel-link stock-more" data-view="inventory">Ver ${group.items.length - limit} más →</button>` : ""}
  </section>`).join("");
}

function inventorySalesAnalysis() {
  const end = localDateTime().slice(0, 10);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 60);
  const cutoff = dateKey(cutoffDate);
  const products = query(`SELECT p.id,p.name,p.category,p.stock,p.unit,p.min_stock,p.active,
      stats.units_60d,stats.sales_60d,last_sale.last_sold
    FROM products p
    LEFT JOIN (
      SELECT i.product_id,SUM(i.quantity) AS units_60d,COUNT(DISTINCT s.id) AS sales_60d
      FROM sale_items i JOIN sales s ON s.id=i.sale_id
      WHERE s.status='completed' AND s.date>=? AND s.date<?
      GROUP BY i.product_id
    ) stats ON stats.product_id=p.id
    LEFT JOIN (
      SELECT i.product_id,MAX(s.date) AS last_sold
      FROM sale_items i JOIN sales s ON s.id=i.sale_id
      WHERE s.status='completed'
      GROUP BY i.product_id
    ) last_sale ON last_sale.product_id=p.id
    WHERE p.active=1`, [cutoff, `${end} 23:59:59`]);
  const bestSellers = products.filter((product) => Number(product.units_60d) > 0)
    .sort((a, b) => Number(b.units_60d) - Number(a.units_60d) || String(a.name).localeCompare(String(b.name), "es"))
    .slice(0, 5);
  const noRecentSales = products.filter((product) => !product.last_sold || String(product.last_sold).slice(0, 10) < cutoff)
    .sort((a, b) => String(a.last_sold || "").localeCompare(String(b.last_sold || "")));
  const lowSales = products.filter((product) => {
    const units = Number(product.units_60d) || 0;
    return units > 0 && units <= 2 && product.last_sold && String(product.last_sold).slice(0, 10) >= cutoff;
  }).sort((a, b) => Number(a.units_60d) - Number(b.units_60d));
  const bestRows = bestSellers.length ? bestSellers.map((product, index) => `<div class="analysis-row"><span class="rank-badge">${index + 1}</span><span class="stock-product"><b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.category || "Sin categoría")}</small></span><span class="analysis-metric">${quantityLabel(product.units_60d, product.unit)}</span><button class="button button-muted button-small stock-restock" data-action="restock-product" data-id="${product.id}">Reponer</button></div>`).join("") : emptyState("Aún no hay ventas", "Los productos vendidos aparecerán aquí.");
  const slowRows = (items, mode) => items.length ? items.slice(0, 8).map((product) => {
    const noSales = mode === "no-sales";
    const detail = noSales
      ? product.last_sold ? `Última venta: ${dateLabel(product.last_sold)}` : "Nunca vendido"
      : `${quantityLabel(product.units_60d, product.unit)} en 60 días · ${Number(product.sales_60d) || 0} ventas`;
    return `<div class="analysis-row"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span class="stock-product"><b>${escapeHtml(product.name)}</b><small>${detail}</small></span><span class="analysis-metric">${quantityLabel(product.stock, product.unit)}</span><button class="button button-muted button-small stock-restock" data-action="restock-product" data-id="${product.id}">Reponer</button></div>`;
  }).join("") : emptyState(mode === "no-sales" ? "Todo en movimiento" : "Sin ventas bajas", mode === "no-sales" ? "Todos los productos tuvieron ventas en los últimos 60 días." : "No hay productos con 1 o 2 unidades vendidas en los últimos 60 días.");
  return {
    bestRows,
    noRecentSales,
    lowSales,
    slowPanels: `<div class="analysis-columns"><article class="panel analysis-panel"><div class="panel-heading"><div><h2>Sin ventas recientes</h2><p>Sin ventas en los últimos 60 días o nunca vendidos</p></div><span class="analysis-count critical-text">${noRecentSales.length}</span></div><div class="analysis-list">${slowRows(noRecentSales, "no-sales")}</div></article><article class="panel analysis-panel"><div class="panel-heading"><div><h2>Ventas bajas</h2><p>1–2 unidades vendidas en los últimos 60 días</p></div><span class="analysis-count low-text">${lowSales.length}</span></div><div class="analysis-list">${slowRows(lowSales, "low-sales")}</div></article></div>`
  };
}

function renderDashboard() {
  const today = localDateTime().slice(0, 10);
  const month = today.slice(0, 7);
  const salesToday = Number(scalar("SELECT COALESCE(SUM(total),0) AS value FROM sales WHERE status='completed' AND date LIKE ?", [`${today}%`])) || 0;
  const salesMonth = Number(scalar("SELECT COALESCE(SUM(total),0) AS value FROM sales WHERE status='completed' AND date LIKE ?", [`${month}%`])) || 0;
  const productCount = Number(scalar("SELECT COUNT(*) AS value FROM products WHERE active=1")) || 0;
  const stockGroups = dashboardStockGroups();
  const lowStock = stockGroups.reduce((sum, group) => sum + group.items.length, 0);
  const recentSales = query(`SELECT s.id,s.date,s.total,c.name AS customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 5`);
  const chartRangeLabels = { week: "7 días", month: "Mensual", six: "6 meses", thirteen: "13 meses" };
  const chartTitle = { week: "Ventas de la semana", month: "Ventas del mes", six: "Ventas de 6 meses", thirteen: "Ventas de 13 meses" }[dashboardRange];
  return `${pageHeading("VISTA GENERAL", "Hola, aquí está tu negocio.", "Un resumen claro para que sepas cómo va todo hoy.")}
    <section class="stats-grid">
      ${statCard("Ventas de hoy", money(salesToday), "Total registrado durante el día", "↗")}
      ${statCard("Ventas del mes", money(salesMonth), "Acumulado del mes en curso", "▤")}
      ${statCard("Productos", String(productCount), "Productos en tu catálogo", "◇")}
      ${statCard("Por reponer", String(lowStock), lowStock ? "Críticos, bajos o por sugerencia" : "Todo tu inventario está al día", "▦")}
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-heading chart-panel-heading"><div><h2>${chartTitle}</h2><p>Ingresos completados · en pesos chilenos</p></div><div class="chart-range-switch" role="group" aria-label="Período del gráfico">${Object.entries(chartRangeLabels).map(([range, label]) => `<button class="chart-range-button ${dashboardRange === range ? "active" : ""}" data-chart-range="${range}" aria-pressed="${dashboardRange === range}">${label}</button>`).join("")}</div></div><div class="chart-legend"><span><i class="legend-dot positive"></i>Subida</span><span><i class="legend-dot negative"></i>Bajada</span></div><div class="chart-wrap">${dashboardChart()}</div></article>
      <article class="panel list-panel"><div class="panel-heading"><div><h2>Reposición de stock</h2><p>Según el stock mínimo configurado</p></div><button class="panel-link" data-view="inventory">Ver inventario →</button></div><div class="stock-list">${stockGroupMarkup(3)}</div><p class="stock-note">Crítico: sin stock · Bajo: bajo el mínimo · Sugerencia: hasta 50% sobre el mínimo.</p></article>
    </section>
    <article class="panel section-spacer"><div class="panel-heading"><div><h2>Últimas ventas</h2><p>Actividad reciente de tu negocio</p></div><button class="panel-link" data-view="sales">Ir a ventas →</button></div>
      ${recentSales.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>VENTA</th><th>FECHA</th><th>CLIENTE</th><th>TOTAL</th><th></th></tr></thead><tbody>${recentSales.map((sale) => `<tr><td><strong>#${sale.id}</strong></td><td>${dateLabel(sale.date)}</td><td>${escapeHtml(sale.customer || "Venta sin cliente")}</td><td><strong>${money(sale.total)}</strong></td><td><div class="action-cell"><button class="table-action" data-action="edit-sale" data-id="${sale.id}">Editar</button><button class="table-action danger-action" data-action="confirm-delete-sale" data-id="${sale.id}">Borrar</button></div></td></tr>`).join("")}</tbody></table></div>` : emptyState("Aún no hay ventas", "Cuando registres una venta, aparecerá aquí.")}</article>`;
}

function searchToolbar(placeholder, button = "") {
  return `<div class="table-toolbar"><label class="search-field"><span aria-hidden="true">⌕</span><input id="table-search" type="search" value="${escapeHtml(searchValue)}" placeholder="${placeholder}"></label>${button}</div>`;
}

function productRows(products) {
  if (!products.length) return `<tr><td colspan="7">${emptyState("Sin productos", "Agrega un producto para comenzar.")}</td></tr>`;
  return products.map((product) => `<tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.sku || product.barcode || "—")}</td><td>${escapeHtml(product.category || "—")}</td><td>${money(product.price)}</td><td>${quantityLabel(product.stock, product.unit)}</td><td>${product.stock <= product.min_stock ? `<span class="low-pill">Reponer · mín. ${quantityLabel(product.min_stock, product.unit)}</span>` : `<span class="good-pill">Disponible</span>`}</td><td><button class="table-action" data-action="edit-product" data-id="${product.id}">Editar</button></td></tr>`).join("");
}

function renderProducts() {
  const term = searchValue.toLocaleLowerCase("es");
  const products = query("SELECT id,name,sku,category,price,cost,stock,min_stock,barcode,unit,net_price,tax_exempt,description FROM products ORDER BY name")
    .filter((product) => `${product.name} ${product.sku} ${product.barcode} ${product.category}`.toLocaleLowerCase("es").includes(term));
  const addButton = `<button class="button button-primary button-small" data-action="new-product">+ Agregar producto</button>`;
  return `${pageHeading("CATÁLOGO", "Tus productos", "Administra precios, categorías y disponibilidad.", addButton)}
    <article class="panel table-panel">${searchToolbar("Buscar por nombre, código o categoría")}<div class="table-scroll"><table class="data-table"><thead><tr><th>PRODUCTO</th><th>CÓDIGO</th><th>CATEGORÍA</th><th>PRECIO</th><th>STOCK</th><th>ESTADO</th><th></th></tr></thead><tbody>${productRows(products)}</tbody></table></div></article>`;
}

function renderInventory() {
  const term = searchValue.toLocaleLowerCase("es");
  const products = query("SELECT id,name,sku,barcode,category,price,stock,min_stock,unit FROM products ORDER BY name")
    .filter((product) => `${product.name} ${product.sku} ${product.barcode} ${product.category}`.toLocaleLowerCase("es").includes(term));
  const analysis = inventorySalesAnalysis();
  const button = `<button class="button button-muted button-small" data-action="export-inventory">↓ Exportar a Excel</button><button class="button button-primary button-small" data-action="new-movement">+ Registrar movimiento</button>`;
  const rows = products.length ? products.map((product) => `<tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${escapeHtml(product.sku || "—")}</td><td>${escapeHtml(product.category || "—")}</td><td>${quantityLabel(product.stock, product.unit)}</td><td>${quantityLabel(product.min_stock, product.unit)}</td><td>${product.stock <= product.min_stock ? `<span class="low-pill">Reponer · mín. ${quantityLabel(product.min_stock, product.unit)}</span>` : `<span class="good-pill">En orden</span>`}</td><td><div class="action-cell"><button class="table-action" data-action="movement-for-product" data-id="${product.id}">Ajustar</button><button class="table-action" data-action="restock-product" data-id="${product.id}">Reponer</button></div></td></tr>`).join("") : `<tr><td colspan="7">${emptyState("Inventario vacío", "Agrega productos para ver su stock.")}</td></tr>`;
  return `${pageHeading("CONTROL DE STOCK", "Inventario", "Mantén el stock al día: registra entradas, ajustes, devoluciones y pérdidas.", button)}
    <article class="panel list-panel inventory-replenishment"><div class="panel-heading"><div><h2>Reposición de stock</h2><p>El mismo semáforo del resumen, con acceso rápido para reponer</p></div></div><div class="stock-list">${stockGroupMarkup(Number.MAX_SAFE_INTEGER)}</div><p class="stock-note">Crítico: sin stock · Bajo: en o debajo del mínimo · Sugerencia: hasta 50% sobre el mínimo.</p></article>
    <section class="inventory-analysis"><article class="panel analysis-panel"><div class="panel-heading"><div><h2>Productos más vendidos</h2><p>Unidades vendidas en los últimos 60 días</p></div></div><div class="analysis-list">${analysis.bestRows}</div></article>${analysis.slowPanels}</section>
    <article class="panel table-panel">${searchToolbar("Buscar producto") }<div class="table-scroll"><table class="data-table"><thead><tr><th>PRODUCTO</th><th>CÓDIGO</th><th>CATEGORÍA</th><th>STOCK ACTUAL</th><th>STOCK MÍNIMO</th><th>ESTADO</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function exportInventory() {
  const products = query("SELECT name,sku,category,price,stock,min_stock,unit FROM products ORDER BY name");
  const xmlEscape = (value) => String(value ?? "").replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  })[character]);
  const cell = (value, type = "String") => `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;
  const rows = [
    ["Producto", "Código", "Categoría", "Precio", "Stock actual", "Stock mínimo", "Unidad", "Estado"],
    ...products.map((product) => [
      product.name,
      product.sku || "",
      product.category || "",
      Number(product.price) || 0,
      Number(product.stock) || 0,
      Number(product.min_stock) || 0,
      product.unit || "UN",
      product.stock <= product.min_stock ? "Reponer" : "En orden"
    ])
  ];
  const worksheet = rows.map((row, rowIndex) => `<Row>${row.map((value, columnIndex) => {
    const type = rowIndex > 0 && columnIndex >= 3 && columnIndex <= 5 ? "Number" : "String";
    return cell(value, type);
  }).join("")}</Row>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Inventario"><Table>${worksheet}</Table></Worksheet></Workbook>`;
  const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inventario-${new Date().toISOString().slice(0, 10)}.xls`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Inventario exportado con ${products.length} ${products.length === 1 ? "producto" : "productos"}.`);
}

function renderSales() {
  const products = query("SELECT id,name,sku,barcode,category,price,stock,unit,net_price,cost,tax_exempt FROM products WHERE active=1 ORDER BY name");
  const originalItems = editingSaleId
    ? query("SELECT product_id, SUM(quantity) AS quantity FROM sale_items WHERE sale_id=? GROUP BY product_id", [editingSaleId])
    : [];
  const originalQtyByProduct = new Map(originalItems.map((row) => [Number(row.product_id), Number(row.quantity) || 0]));
  for (const product of products) {
    product.availableStock = Number(product.stock) + (originalQtyByProduct.get(Number(product.id)) || 0);
  }
  const term = searchValue.toLocaleLowerCase("es");
  const filtered = products.filter((product) => `${product.name} ${product.sku} ${product.barcode} ${product.category}`.toLocaleLowerCase("es").includes(term));
  const customers = query("SELECT id,name FROM customers ORDER BY name");
  const subTotal = saleCart.reduce((total, item) => total + Math.round(item.price * item.quantity), 0);
  const discount = Math.min(Number(saleDiscount) || 0, subTotal);
  const total = subTotal - discount;
  const documentTypes = ["BOLETA", "FACTURA", "TICKET_INTERNO"];
  const isSplitPayment = paymentRows.length > 1;
  const isSingleNonCash = !isSplitPayment && paymentRows[0]?.type !== "Efectivo";
  const effectiveAmounts = paymentRows.map((row) => isSingleNonCash ? total : (Number(row.amount) || 0));
  const paymentTotal = effectiveAmounts.reduce((sum, amount) => sum + amount, 0);
  const cashPaymentTotal = paymentRows.reduce((sum, row, index) => sum + (row.type === "Efectivo" ? effectiveAmounts[index] : 0), 0);
  const otherPaymentTotal = paymentTotal - cashPaymentTotal;
  const changeDue = otherPaymentTotal <= total && paymentTotal > total ? paymentTotal - total : 0;
  const paymentStatus = otherPaymentTotal > total
    ? `Pagos sin efectivo exceden ${money(otherPaymentTotal - total)}`
    : paymentTotal === total
      ? "Monto exacto"
      : paymentTotal < total
        ? `Faltan ${money(total - paymentTotal)}`
        : changeDue > 0
          ? `Vuelto: ${money(changeDue)}`
          : `Excede ${money(paymentTotal - total)}; solo efectivo permite vuelto`;
  const paymentError = paymentTotal < total || otherPaymentTotal > total || (paymentTotal > total && changeDue === 0);
  const productResults = filtered.length ? filtered.map((product) => {
    const codeText = [product.sku, product.barcode].filter(Boolean).join(" · ");
    return `<div class="result-row"><span class="product-avatar">${escapeHtml(product.name.slice(0, 1))}</span><span class="result-info"><b>${escapeHtml(product.name)}</b><small>${quantityLabel(product.availableStock, product.unit)} disponibles${codeText ? ` · ${escapeHtml(codeText)}` : ""}</small></span><span class="result-price">${money(product.price)}</span><button class="icon-button" data-action="add-cart" data-id="${product.id}" aria-label="Agregar ${escapeHtml(product.name)}" ${product.availableStock <= 0 ? "disabled" : ""}>+</button></div>`;
  }).join("") : emptyState("No encontramos productos", "Agrega productos en la sección Productos.");
  const cartContents = saleCart.length ? saleCart.map((item) => `<div class="cart-row"><span class="cart-name"><b>${escapeHtml(item.name)}</b><small>${money(item.price)} / ${item.unit} · ${money(item.price * item.quantity)}</small></span><span class="qty-controls"><input class="cart-quantity" data-cart-quantity="${item.id}" type="number" min="0.001" max="${item.stock}" step="${item.unit === "UN" || item.unit === "CAJA" ? "1" : "0.001"}" value="${item.quantity}" aria-label="Cantidad de ${escapeHtml(item.name)}"><button class="payment-remove" type="button" data-action="remove-cart-item" data-id="${item.id}" aria-label="Quitar ${escapeHtml(item.name)}" title="Quitar producto">×</button></span></div>`).join("") : emptyState("Tu venta está vacía", "Pistolea un código de barras o busca un producto para agregarlo aquí.");
  const paymentMarkup = paymentRows.map((payment, index) => {
    const showAmountInput = isSplitPayment || payment.type === "Efectivo";
    return `<div class="payment-entry ${showAmountInput ? "with-amount" : "single-method"}">
      <select data-payment-type="${index}" aria-label="Tipo de pago">${PAYMENT_TYPES.map((type) => `<option ${type === payment.type ? "selected" : ""}>${type}</option>`).join("")}</select>
      ${showAmountInput ? `<input data-payment-amount="${index}" type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(payment.amount)}" placeholder="$ monto" aria-label="Monto del pago">` : ""}
      ${index > 0 ? `<button class="payment-remove" type="button" data-action="remove-payment" data-index="${index}" aria-label="Eliminar medio de pago ${index + 1}" title="Eliminar medio de pago">×</button>` : ""}
    </div>`;
  }).join("");
  const historyButton = `${editingSaleId ? `<button class="button button-muted button-small" data-action="cancel-edit-sale">Cancelar edición</button>` : ""}<button class="button button-muted button-small" data-view="sales-history">◷ Historial de ventas</button>`;
  return `${pageHeading(editingSaleId ? "EDICIÓN DE VENTA" : "REGISTRO DE VENTAS", editingSaleId ? `Editar venta #${editingSaleId}` : "Ventas", editingSaleId ? "Modifica los productos, el descuento o los medios de pago y guarda los cambios." : "Crea ventas, aplica descuentos y combina medios de pago.", historyButton)}
    <div class="sale-layout">
      <article class="panel cart-panel"><div class="panel-heading"><div><h2>${editingSaleId ? `Venta #${editingSaleId}` : "Tu venta"}</h2><p>${saleCart.length} producto${saleCart.length === 1 ? "" : "s"} agregado${saleCart.length === 1 ? "" : "s"}</p></div></div><div class="cart-items">${cartContents}</div>
        <div class="cart-footer"><div class="field"><label for="sale-customer">Cliente (opcional)</label><select id="sale-customer"><option value="" ${saleCustomerId === "" ? "selected" : ""}>Venta sin cliente</option>${customers.map((customer) => `<option value="${customer.id}" ${String(customer.id) === saleCustomerId ? "selected" : ""}>${escapeHtml(customer.name)}</option>`).join("")}</select></div>
          <div class="form-row"><div class="field"><label for="sale-document-type">Documento</label><select id="sale-document-type">${documentTypes.map((type) => `<option ${type === saleDocumentType ? "selected" : ""}>${type}</option>`).join("")}</select></div>${field("sale-folio", "Folio", saleFolio)}</div>
          <div class="field"><label for="sale-discount">Descuento (CLP)</label><input id="sale-discount" type="text" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(saleDiscount)}"></div>
          <div class="cart-line"><span>Subtotal</span><span>${money(subTotal)}</span></div><div class="cart-line"><span>Descuento</span><span>− ${money(discount)}</span></div><div class="cart-line total"><span>Total a pagar</span><span>${money(total)}</span></div>
          <div class="payment-header"><b>MEDIOS DE PAGO</b><button class="table-action" data-action="add-payment">+ Dividir pago</button></div>${paymentMarkup}
          <div id="payment-balance" class="payment-balance ${paymentError ? "error" : changeDue > 0 ? "change-due" : ""}">Ingresado: ${money(paymentTotal)} · ${paymentStatus}</div>
          <button class="button button-primary full-width" data-action="complete-sale" ${saleCart.length === 0 ? "disabled" : ""}>${editingSaleId ? "Guardar cambios de la venta" : "Completar venta"}</button>
        </div>
      </article>
      <article class="panel table-panel product-search-panel"><div class="panel-heading"><div><h2>Agregar productos</h2><p>Pistolea con el lector de código de barras o busca manualmente</p></div></div>${searchToolbar("Pistolea el código de barras o busca por nombre / código…")}<div class="search-results">${productResults}</div></article>
    </div>`;
}

function salesTable(sales) {
  const rows = sales.length ? sales.map((sale) => `<tr><td><strong>#${sale.id}</strong></td><td>${dateLabel(sale.date)}</td><td>${escapeHtml(sale.customer || "Venta sin cliente")}</td><td>${sale.discount ? money(sale.discount) : "—"}</td><td><strong>${money(sale.total)}</strong></td><td><span class="${sale.status === "completed" ? "good-pill" : "neutral-pill"}">${sale.status === "completed" ? "Completada" : sale.status === "pending" ? "Pendiente" : "Anulada"}</span></td><td><div class="action-cell"><button class="table-action" data-action="edit-sale" data-id="${sale.id}">Editar</button><button class="table-action danger-action" data-action="confirm-delete-sale" data-id="${sale.id}">Borrar</button></div></td></tr>`).join("") : `<tr><td colspan="7">${emptyState("Sin ventas registradas", "No hay ventas en este período.")}</td></tr>`;
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>VENTA</th><th>FECHA</th><th>CLIENTE</th><th>DESCUENTO</th><th>TOTAL</th><th>ESTADO</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function salesSummary(sales, label) {
  const completedSales = sales.filter((sale) => sale.status === "completed");
  const total = completedSales.reduce((sum, sale) => sum + Number(sale.total), 0);
  return `<div class="history-summary"><div><b>${completedSales.length}</b><small>VENTAS COMPLETADAS · ${label}</small></div><div><b>${money(total)}</b><small>TOTAL VENDIDO</small></div></div>`;
}

function renderSalesHistory() {
  const today = new Date();
  const todayKey = dateKey(today);
  const monthStart = dateKey(new Date(today.getFullYear(), today.getMonth(), 1));
  const monthName = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(today);
  const monthSales = query(`SELECT s.id,s.date,s.total+s.discount AS subtotal,s.discount,s.total,s.status,s.document_type,s.folio,c.name AS customer
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
    WHERE substr(s.date,1,10)>=? AND substr(s.date,1,10)<=?
    ORDER BY s.date DESC,s.id DESC`, [monthStart, todayKey]);
  const todaySales = monthSales.filter((sale) => String(sale.date).slice(0, 10) === todayKey);
  const backButton = `<button class="button button-muted button-small" data-view="sales">← Volver a ventas</button>`;
  return `${pageHeading("CONSULTA", "Historial de ventas", "Consulta las ventas del día y del mes, o exporta cualquier período en Excel.", backButton)}
    <article class="panel sales-export-panel">
      <div class="panel-heading"><div><h2>Exportar registro de ventas</h2><p>Elige las fechas que quieres descargar o usa un período mensual rápido.</p></div></div>
      <div class="sales-export-controls">
        <div class="field"><label for="sales-period-start">Desde</label><input id="sales-period-start" type="date" value="${todayKey}"></div>
        <div class="field"><label for="sales-period-end">Hasta</label><input id="sales-period-end" type="date" value="${todayKey}"></div>
        <button class="button button-primary button-small" data-action="export-sales-period">Exportar período</button>
        <span class="quick-export-label">Descarga rápida</span>
        <button class="button button-muted button-small" data-action="export-sales-month" data-offset="0">Mes actual</button>
        <button class="button button-muted button-small" data-action="export-sales-month" data-offset="-1">Mes pasado</button>
      </div>
    </article>
    <article class="panel table-panel sales-history-panel">
      <div class="panel-heading"><div><h2>Ventas del día</h2><p>${dateLabel(todayKey)}</p></div></div>
      ${salesSummary(todaySales, "HOY")}
      ${salesTable(todaySales)}
    </article>
    <article class="panel table-panel sales-history-panel">
      <div class="panel-heading"><div><h2>Ventas del mes</h2><p>${escapeHtml(monthName)}</p></div></div>
      ${salesSummary(monthSales, "ESTE MES")}
      ${salesTable(monthSales)}
    </article>`;
}

function exportSalesPeriod(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Selecciona una fecha de inicio y una fecha de término.");
  }
  if (start > end) throw new Error("La fecha de inicio no puede ser posterior a la fecha de término.");
  const sales = query(`SELECT s.id,s.date,s.total+s.discount AS subtotal,s.discount,s.total,s.status,s.document_type,s.folio,c.name AS customer
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id
    WHERE substr(s.date,1,10)>=? AND substr(s.date,1,10)<=?
    ORDER BY s.date,s.id`, [start, end]);
  const xmlEscape = (value) => String(value ?? "").replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  })[character]);
  const columns = ["Venta", "Fecha", "Cliente", "Subtotal", "Descuento", "Total", "Estado", "Documento", "Folio"];
  const rows = [
    columns,
    ...sales.map((sale) => [
      sale.id, String(sale.date).slice(0, 10), sale.customer || "Venta sin cliente",
      Number(sale.subtotal) || 0, Number(sale.discount) || 0, Number(sale.total) || 0,
      sale.status === "completed" ? "Completada" : sale.status === "pending" ? "Pendiente" : "Anulada",
      sale.document_type || "", sale.folio || ""
    ])
  ];
  const worksheet = rows.map((row, rowIndex) => `<Row>${row.map((value, columnIndex) => {
    const type = rowIndex > 0 && [0, 3, 4, 5].includes(columnIndex) ? "Number" : "String";
    return `<Cell><Data ss:Type="${type}">${xmlEscape(value)}</Data></Cell>`;
  }).join("")}</Row>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Ventas"><Table>${worksheet}</Table></Worksheet></Workbook>`;
  const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `ventas-${start}-a-${end}.xls`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Registro exportado: ${sales.length} ${sales.length === 1 ? "venta" : "ventas"}.`);
}

function exportSalesMonth(offset) {
  const month = addMonths(new Date(), offset);
  const start = dateKey(month);
  const end = dateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0));
  exportSalesPeriod(start, end);
}

function renderCustomers() {
  if (customerHistoryId !== null) return renderCustomerHistory(customerHistoryId);
  const term = searchValue.toLocaleLowerCase("es");
  const customers = query(`SELECT c.id,c.name,c.phone,c.email,c.created_at,COUNT(s.id) AS sales_count,COALESCE(SUM(s.total),0) AS total FROM customers c LEFT JOIN sales s ON s.customer_id=c.id GROUP BY c.id ORDER BY c.name`)
    .filter((customer) => `${customer.name} ${customer.phone} ${customer.email}`.toLocaleLowerCase("es").includes(term));
  const rows = customers.length ? customers.map((customer) => `<tr><td><strong>${escapeHtml(customer.name)}</strong></td><td>${escapeHtml(customer.phone || "—")}</td><td>${escapeHtml(customer.email || "—")}</td><td>${customer.sales_count}</td><td>${money(customer.total)}</td><td><button class="table-action" data-action="customer-history" data-id="${customer.id}">Ver historial →</button></td></tr>`).join("") : `<tr><td colspan="6">${emptyState("Aún no hay clientes", "Agrega clientes para mantener su historial.")}</td></tr>`;
  return `${pageHeading("RELACIONES", "Clientes", "Cada cliente conserva el historial completo de sus compras.", `<button class="button button-primary button-small" data-action="new-customer">+ Agregar cliente</button>`)}
    <article class="panel table-panel">${searchToolbar("Buscar cliente por nombre, teléfono o correo")}<div class="table-scroll"><table class="data-table"><thead><tr><th>CLIENTE</th><th>TELÉFONO</th><th>CORREO</th><th>VENTAS</th><th>TOTAL COMPRADO</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function renderCustomerHistory(customerId) {
  const customer = query("SELECT * FROM customers WHERE id = ?", [customerId])[0];
  if (!customer) {
    customerHistoryId = null;
    return renderCustomers();
  }
  const sales = query(`SELECT id,date,subtotal,discount,total FROM sales WHERE customer_id = ? ORDER BY id DESC`, [customerId]);
  const total = sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const items = query(`SELECT si.sale_id,si.product_name,si.quantity,si.unit_price,si.line_total FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.customer_id=? ORDER BY s.id DESC,si.id`, [customerId]);
  const rows = sales.length ? sales.map((sale) => {
    const saleItems = items.filter((item) => item.sale_id === sale.id);
    return `<tr><td><strong>#${sale.id}</strong></td><td>${dateLabel(sale.date)}</td><td>${saleItems.map((item) => `${escapeHtml(item.product_name)} × ${item.quantity}`).join("<br>")}</td><td>${sale.discount ? money(sale.discount) : "—"}</td><td><strong>${money(sale.total)}</strong></td><td><div class="action-cell"><button class="table-action" data-action="edit-sale" data-id="${sale.id}">Editar</button><button class="table-action danger-action" data-action="confirm-delete-sale" data-id="${sale.id}">Borrar</button></div></td></tr>`;
  }).join("") : `<tr><td colspan="6">${emptyState("Todavía no tiene compras", "Al asociar una venta con este cliente, aparecerá en su historial.")}</td></tr>`;
  return `<div class="detail-bar"><button class="detail-back" data-action="back-customers">← Volver a clientes</button></div>
    ${pageHeading("HISTORIAL DEL CLIENTE", escapeHtml(customer.name), `${escapeHtml(customer.phone || "Sin teléfono")} · ${escapeHtml(customer.email || "Sin correo")}`)}
    <div class="history-summary"><div><b>${sales.length}</b><small>VENTAS REGISTRADAS</small></div><div><b>${money(total)}</b><small>TOTAL COMPRADO</small></div></div>
    <article class="panel table-panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>VENTA</th><th>FECHA</th><th>PRODUCTOS</th><th>DESCUENTO</th><th>TOTAL</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function renderSuppliers() {
  const term = searchValue.toLocaleLowerCase("es");
  const suppliers = query(`SELECT s.id,s.name,s.phone,s.email,COUNT(CASE WHEN m.type='entry' THEN m.id END) AS movements FROM suppliers s LEFT JOIN stock_movements m ON m.supplier_id=s.id GROUP BY s.id ORDER BY s.name`)
    .filter((supplier) => `${supplier.name} ${supplier.phone} ${supplier.email}`.toLocaleLowerCase("es").includes(term));
  const rows = suppliers.length ? suppliers.map((supplier) => `<tr><td><strong>${escapeHtml(supplier.name)}</strong></td><td>${escapeHtml(supplier.phone || "—")}</td><td>${escapeHtml(supplier.email || "—")}</td><td>${supplier.movements}</td><td><button class="table-action" data-action="new-movement" data-supplier-id="${supplier.id}">Registrar entrada</button></td></tr>`).join("") : `<tr><td colspan="5">${emptyState("Aún no hay proveedores", "Agrega proveedores para asociarlos a tus compras de stock.")}</td></tr>`;
  return `${pageHeading("RED DE ABASTECIMIENTO", "Proveedores", "Guarda sus datos y asócialos a las entradas de inventario.", `<button class="button button-primary button-small" data-action="new-supplier">+ Agregar proveedor</button>`)}
    <article class="panel table-panel">${searchToolbar("Buscar proveedor por nombre o contacto")}<div class="table-scroll"><table class="data-table"><thead><tr><th>PROVEEDOR</th><th>TELÉFONO</th><th>CORREO</th><th>ENTRADAS ASOCIADAS</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function renderFinances() {
  const today = new Date();
  const todayKey = dateKey(today);
  const firstDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
  const firstDayKey = dateKey(firstDay);
  const currentMonth = monthKey(today);
  const prevMonthDate = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -1);
  const prevMonth = monthKey(prevMonthDate);
  const firstMonth = monthKey(addMonths(new Date(today.getFullYear(), today.getMonth(), 1), -(financeRange - 1)));
  const previousYearMonth = monthKey(new Date(today.getFullYear() - 1, today.getMonth(), 1));
  const reportStartMonth = previousYearMonth < firstMonth ? previousYearMonth : firstMonth;
  const percentFormatter = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const pct = (value) => `${percentFormatter.format(Number(value) || 0)}%`;
  const deltaBadge = (current, previous) => {
    if (!previous && !current) return "Sin variación vs. mes anterior";
    if (!previous) return "▲ Nuevo este mes (sin registro mes anterior)";
    const diff = ((current - previous) / Math.abs(previous)) * 100;
    const sign = diff > 0 ? "▲ +" : diff < 0 ? "▼ " : "• ";
    return `${sign}${pct(diff)} vs. mes anterior (${money(previous)})`;
  };

  const monthlySales = query(`SELECT substr(s.date,1,7) AS month, SUM(s.total - s.tax) AS sales,
      SUM(s.total) AS gross_sales,
      SUM(COALESCE(i.cost,0)) AS cost, SUM(COALESCE(i.units,0)) AS units, COUNT(*) AS transactions,
      SUM(CASE WHEN substr(s.date,1,10) BETWEEN ? AND ? THEN s.total - s.tax ELSE 0 END) AS recent_sales
    FROM sales s LEFT JOIN (
      SELECT si.sale_id, SUM(si.quantity*si.unit_cost) AS cost, SUM(si.quantity) AS units
      FROM sale_items si JOIN sales filtered ON filtered.id=si.sale_id
      WHERE filtered.status='completed' AND substr(filtered.date,1,7)>=? AND substr(filtered.date,1,7)<=?
      GROUP BY si.sale_id
    ) i ON i.sale_id=s.id
    WHERE s.status='completed' AND substr(s.date,1,7)>=? AND substr(s.date,1,7)<=?
    GROUP BY substr(s.date,1,7)`, [firstDayKey, todayKey, reportStartMonth, currentMonth, reportStartMonth, currentMonth]);
  const monthlyMovements = query(`SELECT substr(date,1,7) AS month,
      SUM(CASE WHEN type='loss' THEN ABS(quantity)*COALESCE(cost,0) ELSE 0 END) AS losses,
      SUM(CASE WHEN type='entry' THEN ABS(quantity)*COALESCE(cost,0) ELSE 0 END) AS purchases,
      SUM(CASE WHEN type='loss' AND substr(date,1,10) BETWEEN ? AND ?
        THEN ABS(quantity)*COALESCE(cost,0) ELSE 0 END) AS recent_losses
    FROM stock_movements
    WHERE type IN ('loss','entry') AND substr(date,1,7)>=? AND substr(date,1,7)<=?
    GROUP BY substr(date,1,7)`, [firstDayKey, todayKey, firstMonth, currentMonth]);
  const monthlyExpenses = query(`SELECT substr(date,1,7) AS month, SUM(amount) AS amount
    FROM expenses WHERE substr(date,1,7)>=? AND substr(date,1,7)<=?
    GROUP BY substr(date,1,7)`, [firstMonth, currentMonth]);
  const salesByMonth = new Map(monthlySales.map((row) => [row.month, row]));
  const movementsByMonth = new Map(monthlyMovements.map((row) => [row.month, row]));
  const expensesByMonth = new Map(monthlyExpenses.map((row) => [row.month, Number(row.amount) || 0]));
  const salesForMonth = (month) => salesByMonth.get(month) || {};
  const movementsForMonth = (month) => movementsByMonth.get(month) || {};
  const monthSales = Number(salesForMonth(currentMonth).sales) || 0;
  const prevMonthSales = Number(salesForMonth(prevMonth).sales) || 0;
  const previousYearSales = Number(salesForMonth(previousYearMonth).sales) || 0;
  const monthGrossSales = Number(salesForMonth(currentMonth).gross_sales) || 0;
  const prevMonthGrossSales = Number(salesForMonth(prevMonth).gross_sales) || 0;
  const monthTxCount = Number(salesForMonth(currentMonth).transactions) || 0;
  const prevMonthTxCount = Number(salesForMonth(prevMonth).transactions) || 0;
  const monthUnitsSold = Number(salesForMonth(currentMonth).units) || 0;
  const monthCost = Number(salesForMonth(currentMonth).cost) || 0;
  const prevMonthCost = Number(salesForMonth(prevMonth).cost) || 0;
  const monthExpenses = expensesByMonth.get(currentMonth) || 0;
  const prevMonthExpenses = expensesByMonth.get(prevMonth) || 0;
  const monthLosses = Number(movementsForMonth(currentMonth).losses) || 0;
  const prevMonthLosses = Number(movementsForMonth(prevMonth).losses) || 0;
  const monthPurchases = Number(movementsForMonth(currentMonth).purchases) || 0;
  const recentSales = monthlySales.reduce((sum, row) => sum + (Number(row.recent_sales) || 0), 0);
  const recentLosses = monthlyMovements.reduce((sum, row) => sum + (Number(row.recent_losses) || 0), 0);

  const grossProfit = monthSales - monthCost;
  const prevGrossProfit = prevMonthSales - prevMonthCost;
  const grossMarginPct = monthSales > 0 ? (grossProfit / monthSales) * 100 : 0;
  const avgTicket = monthTxCount > 0 ? Math.round(monthGrossSales / monthTxCount) : 0;
  const prevAvgTicket = prevMonthTxCount > 0 ? Math.round(prevMonthGrossSales / prevMonthTxCount) : 0;
  const itemsPerSale = monthTxCount > 0 ? monthUnitsSold / monthTxCount : 0;

  const inventoryStats = query(`SELECT
      COALESCE(SUM(CASE WHEN stock > 0 THEN stock * cost ELSE 0 END), 0) AS cost_value,
      COALESCE(SUM(CASE WHEN stock > 0 THEN stock * price ELSE 0 END), 0) AS retail_value,
      COALESCE(SUM(CASE WHEN stock > 0
        THEN CASE WHEN tax_exempt=1 THEN stock*price ELSE ROUND(stock*price/1.19) END
        ELSE 0 END), 0) AS net_retail_value
    FROM products WHERE active=1`)[0] || { cost_value: 0, retail_value: 0 };
  const inventoryCostValue = Number(inventoryStats.cost_value) || 0;
  const inventoryRetailValue = Number(inventoryStats.retail_value) || 0;
  const inventoryPotentialProfit = (Number(inventoryStats.net_retail_value) || 0) - inventoryCostValue;

  const paymentBreakdown = query(`SELECT p.type, COUNT(DISTINCT p.sale_id) AS sales_count, COALESCE(SUM(p.amount),0) AS amount
    FROM payments p JOIN sales s ON s.id=p.sale_id
    WHERE s.status='completed' AND substr(s.date,1,7)=?
    GROUP BY p.type ORDER BY amount DESC`, [currentMonth]);
  const totalPaymentsMonth = paymentBreakdown.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

  const topProfitProducts = query(`SELECT si.product_name AS name,
      SUM(si.quantity) AS units,
      SUM(si.net_revenue) AS revenue,
      SUM(si.quantity * si.unit_cost) AS cost,
      SUM(si.net_revenue - (si.quantity * si.unit_cost)) AS profit
    FROM sale_items si JOIN sales s ON s.id=si.sale_id
    WHERE s.status='completed' AND substr(s.date,1,7)=?
    GROUP BY si.product_id, si.product_name
    ORDER BY profit DESC, revenue DESC LIMIT 5`, [currentMonth]);

  const expenseCategories = query(`SELECT category, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
    FROM expenses WHERE substr(date,1,7)=?
    GROUP BY category ORDER BY amount DESC`, [currentMonth]);

  const monthlyData = Array.from({ length: financeRange }, (_, index) => {
    const date = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), index - financeRange + 1);
    const key = monthKey(date);
    const sales = salesForMonth(key);
    const movements = movementsForMonth(key);
    const grossEarnings = (Number(sales?.sales) || 0) - (Number(sales?.cost) || 0);
    const losses = (Number(movements.losses) || 0) + (expensesByMonth.get(key) || 0);
    return {
      label: new Intl.DateTimeFormat("es-CL", { month: "short", year: financeRange > 6 ? undefined : "2-digit" }).format(date).replace(".", ""),
      earnings: grossEarnings,
      losses,
      purchases: Number(movements.purchases) || 0
    };
  });
  const chartWidth = 780;
  const chartHeight = 250;
  const chartLeft = 58;
  const chartRight = 766;
  const chartTop = 22;
  const chartBottom = 195;
  const maxValue = Math.max(...monthlyData.flatMap((month) => [month.earnings, month.losses, month.purchases]), 1);
  const minValue = Math.min(...monthlyData.map((month) => month.earnings), 0);
  const chartSpan = maxValue - minValue || 1;
  const chartY = (value) => chartTop + ((maxValue - value) / chartSpan) * (chartBottom - chartTop);
  const zeroY = chartY(0);
  const groupWidth = (chartRight - chartLeft) / monthlyData.length;
  const barWidth = Math.min(20, groupWidth * 0.22);
  const chartGrid = [0, 1, 2, 3, 4].map((index) => {
    const value = maxValue - chartSpan * index / 4;
    const y = chartY(value);
    return `<line x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}" class="chart-gridline"/><text x="${chartLeft - 8}" y="${y + 3}" text-anchor="end" class="chart-text">${escapeHtml(shortMoney(value))}</text>`;
  }).join("");
  const chartBars = monthlyData.map((month, monthIndex) => {
    const center = chartLeft + groupWidth * (monthIndex + 0.5);
    const series = [
      { key: "earnings", label: "Ganancia bruta", value: month.earnings },
      { key: "losses", label: "Pérdidas", value: month.losses },
      { key: "purchases", label: "Compras", value: month.purchases }
    ];
    const bars = series.map((item, seriesIndex) => {
      const x = center + (seriesIndex - 1) * (barWidth + 3) - barWidth / 2;
      const valueY = chartY(item.value);
      const y = Math.min(valueY, zeroY);
      const height = Math.abs(zeroY - valueY);
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="2" class="finance-bar-${item.key}"><title>${escapeHtml(month.label)} · ${item.label}: ${escapeHtml(money(item.value))}</title></rect>`;
    }).join("");
    return `${bars}<text x="${center}" y="222" text-anchor="middle" class="chart-text">${escapeHtml(month.label)}</text>`;
  }).join("");
  const financeChart = `<svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Gráfico mensual de ganancias, pérdidas y compras">${chartGrid}<line x1="${chartLeft}" y1="${zeroY}" x2="${chartRight}" y2="${zeroY}" class="finance-zero-line"/>${chartBars}</svg>`;

  const paymentRowsMarkup = paymentBreakdown.length ? paymentBreakdown.map((item) => {
    const share = totalPaymentsMonth > 0 ? (Number(item.amount) / totalPaymentsMonth) * 100 : 0;
    return `<div class="kpi-bar-row">
      <div class="kpi-bar-head"><b>${escapeHtml(item.type)}</b><span>${money(item.amount)} · ${pct(share)} (${item.sales_count} ${item.sales_count === 1 ? "venta" : "ventas"})</span></div>
      <div class="kpi-bar-track"><i style="width:${Math.max(4, Math.min(100, share))}%"></i></div>
    </div>`;
  }).join("") : emptyState("Sin pagos este mes", "Completa ventas para ver la distribución por medio de pago.");

  const topProductsMarkup = topProfitProducts.length ? topProfitProducts.map((product, index) => {
    const prodMargin = Number(product.revenue) > 0 ? (Number(product.profit) / Number(product.revenue)) * 100 : 0;
    return `<div class="analysis-row">
      <span class="rank-badge">${index + 1}</span>
      <span class="stock-product"><b>${escapeHtml(product.name)}</b><small>Ventas: ${money(product.revenue)} · Margen: ${pct(prodMargin)}</small></span>
      <span class="analysis-metric">${money(product.profit)}</span>
    </div>`;
  }).join("") : emptyState("Sin productos vendidos este mes", "Aquí verás los productos que dejan mayor ganancia.");

  const expenseCategoriesMarkup = expenseCategories.length ? expenseCategories.map((cat) => {
    const share = monthExpenses > 0 ? (Number(cat.amount) / monthExpenses) * 100 : 0;
    return `<div class="kpi-bar-row">
      <div class="kpi-bar-head"><b>${escapeHtml(cat.category)}</b><span>${money(cat.amount)} · ${pct(share)}</span></div>
      <div class="kpi-bar-track kpi-bar-expense"><i style="width:${Math.max(4, Math.min(100, share))}%"></i></div>
    </div>`;
  }).join("") : emptyState("Sin gastos este mes", "Registra gastos para analizar en qué se va tu presupuesto.");

  const expenses = query("SELECT id,date,category,description,amount FROM expenses ORDER BY id DESC LIMIT 50");
  const rows = expenses.length ? expenses.map((expense) => `<tr><td>${dateLabel(expense.date)}</td><td><strong>${escapeHtml(expense.category)}</strong></td><td>${escapeHtml(expense.description)}</td><td>${money(expense.amount)}</td></tr>`).join("") : `<tr><td colspan="4">${emptyState("Sin gastos registrados", "Agrega gastos para tener una vista clara de tus finanzas.")}</td></tr>`;
  const monthLabel = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(today);
  const previousYearLabel = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" })
    .format(new Date(today.getFullYear() - 1, today.getMonth(), 1));
  const yearOverYearChange = previousYearSales > 0
    ? ((monthSales - previousYearSales) / previousYearSales) * 100
    : null;
  const yearOverYearComparison = yearOverYearChange === null
    ? monthSales > 0
      ? `Sin ingresos registrados en ${previousYearLabel} (${money(previousYearSales)})`
      : `Sin ingresos en ambos períodos`
    : `${yearOverYearChange > 0 ? "▲ +" : yearOverYearChange < 0 ? "▼ " : "• "}${pct(yearOverYearChange)} vs. ${previousYearLabel} (${money(previousYearSales)})`;
  const revenueStatus = monthSales < 2_000_000
    ? { className: "low", label: "Menos de $2.000.000" }
    : monthSales <= 6_000_000
      ? { className: "medium", label: "Entre $2.000.000 y $6.000.000" }
      : { className: "high", label: "Más de $6.000.000" };
  const revenueScaleMax = Math.max(8_000_000, Math.ceil(Math.max(0, monthSales) / 2_000_000) * 2_000_000);
  const revenueMarker = Math.max(0, Math.min(100, (monthSales / revenueScaleMax) * 100));
  const lowZoneWidth = (2_000_000 / revenueScaleMax) * 100;
  const mediumZoneWidth = (4_000_000 / revenueScaleMax) * 100;
  const highZoneWidth = 100 - lowZoneWidth - mediumZoneWidth;
  const dailySales = query(`SELECT substr(date,1,10) AS day, SUM(total-tax) AS sales
    FROM sales
    WHERE status='completed' AND substr(date,1,7)=?
    GROUP BY substr(date,1,10)`, [currentMonth]);
  const dailySalesByDate = new Map(dailySales.map((row) => [row.day, Number(row.sales) || 0]));
  const salesDays = Array.from({ length: today.getDate() }, (_, index) => {
    const key = dateKey(new Date(today.getFullYear(), today.getMonth(), index + 1));
    return { day: index + 1, sales: dailySalesByDate.get(key) || 0 };
  });
  const salesChartWidth = 780;
  const salesChartHeight = 240;
  const salesChartLeft = 54;
  const salesChartRight = 766;
  const salesChartTop = 24;
  const salesChartBottom = 190;
  const salesMax = Math.max(...salesDays.map((day) => day.sales), 1);
  const salesGroupWidth = (salesChartRight - salesChartLeft) / salesDays.length;
  const salesBarWidth = Math.min(18, salesGroupWidth * 0.65);
  const salesY = (value) => salesChartBottom - (value / salesMax) * (salesChartBottom - salesChartTop);
  const salesGrid = [0, 1, 2, 3, 4].map((index) => {
    const value = salesMax * (4 - index) / 4;
    const y = salesChartTop + index * (salesChartBottom - salesChartTop) / 4;
    return `<line x1="${salesChartLeft}" y1="${y}" x2="${salesChartRight}" y2="${y}" class="chart-gridline"/><text x="${salesChartLeft - 8}" y="${y + 3}" text-anchor="end" class="chart-text">${escapeHtml(shortMoney(value))}</text>`;
  }).join("");
  const salesBars = salesDays.map((day, index) => {
    const x = salesChartLeft + salesGroupWidth * index + (salesGroupWidth - salesBarWidth) / 2;
    const y = salesY(day.sales);
    const label = String(day.day).padStart(2, "0");
    const bar = day.sales > 0
      ? `<rect x="${x}" y="${y}" width="${salesBarWidth}" height="${salesChartBottom - y}" rx="3" class="finance-month-sales-bar"><title>${label} ${monthLabel} · Ventas: ${escapeHtml(money(day.sales))}</title></rect>`
      : "";
    const tick = index % 5 === 0 || index === salesDays.length - 1
      ? `<text x="${x + salesBarWidth / 2}" y="216" text-anchor="middle" class="chart-text">${day.day}</text>`
      : "";
    return `${bar}${tick}`;
  }).join("");
  const monthlySalesChart = `<svg viewBox="0 0 ${salesChartWidth} ${salesChartHeight}" role="img" aria-label="Ventas completadas por día durante ${escapeHtml(monthLabel)}">${salesGrid}${salesBars}</svg>`;
  const monthlyResultChart = `<section class="panel finance-month-panel finance-profit-${revenueStatus.className} section-spacer">
    <div class="finance-month-heading">
      <div class="finance-month-title"><span class="heading-eyebrow">INGRESOS DEL MES</span><h2>Ingresos de ${escapeHtml(monthLabel)}</h2><p>Ingresos netos sin IVA y con descuentos aplicados.</p></div>
      <div class="finance-month-result finance-result-${revenueStatus.className}"><span>Ingresos del mes</span><strong>${money(monthSales)}</strong><small>${revenueStatus.label}</small><small>${yearOverYearComparison}</small></div>
    </div>
    <div class="finance-month-metrics"><span><small>Ventas completadas</small><strong>${monthTxCount}</strong></span><span><small>Ganancia bruta</small><strong>${money(grossProfit)}</strong></span></div>
    <div class="finance-profit-scale" role="img" aria-label="Ingresos del mes ${escapeHtml(money(monthSales))}. ${revenueStatus.label}.">
      <div class="finance-profit-track"><i class="finance-profit-zone-low" style="width:${lowZoneWidth}%"></i><i class="finance-profit-zone-medium" style="width:${mediumZoneWidth}%"></i><i class="finance-profit-zone-high" style="width:${highZoneWidth}%"></i><b style="left:${revenueMarker}%"></b></div>
      <div class="finance-profit-labels"><span>0</span><span style="left:${lowZoneWidth}%">$2M</span><span style="left:${lowZoneWidth + mediumZoneWidth}%">$6M</span><span>Más</span></div>
    </div>
    <div class="finance-month-chart-heading"><b>Ventas diarias</b><span>Pesos chilenos · día del mes</span></div>
    <div class="chart-wrap finance-month-chart">${monthlySalesChart}</div>
  </section>`;

  return `${pageHeading("INDICADORES CLAVE (KPI)", "Finanzas", ` Estado de resultados, rentabilidad y métricas clave de ${monthLabel}.`, `<button class="button button-primary button-small" data-action="new-expense">+ Registrar gasto</button>`)}
    ${monthlyResultChart}
    <section class="stats-grid">
      ${statCard("Ingresos del mes", money(monthSales), `${yearOverYearComparison} · sin IVA`, "↗")}
      ${statCard("Utilidad bruta", money(grossProfit), `Margen bruto: ${pct(grossMarginPct)} · Costo: ${money(monthCost)}`, "◈")}
      ${statCard("Margen bruto", pct(grossMarginPct), `Ganancia bruta sobre ingresos netos · ${pct(prevMonthSales > 0 ? (prevGrossProfit / prevMonthSales) * 100 : 0)} el mes anterior`, "◷")}
      ${statCard("Ticket promedio", money(avgTicket), `${monthTxCount} ventas este mes · ${quantityFormatter.format(itemsPerSale)} prod/venta`, "▤")}
    </section>
    <section class="stats-grid section-spacer">
      ${statCard("Gastos operativos (mes)", money(monthExpenses), deltaBadge(monthExpenses, prevMonthExpenses), "↘")}
      ${statCard("Mermas (mes)", money(monthLosses), `${deltaBadge(monthLosses, prevMonthLosses)} · 30d: ${money(recentLosses)}`, "⚠")}
      ${statCard("Capital en inventario", money(inventoryCostValue), `Valor venta: ${money(inventoryRetailValue)} · Ganancia pot.: ${money(inventoryPotentialProfit)}`, "▦")}
      ${statCard("Compras de stock (mes)", money(monthPurchases), `Ventas últimos 30 días: ${money(recentSales)}`, "◇")}
    </section>
    <section class="finance-kpi-grid section-spacer">
      <article class="panel kpi-panel">
        <div class="panel-heading"><div><h2>Ganancia bruta del mes</h2><p>Ingresos netos sin IVA y con descuentos, menos el costo de productos vendidos · ${escapeHtml(monthLabel)}</p></div></div>
        <div class="pnl-list">
          <div class="pnl-row"><span>(+) Ingresos por ventas (${monthTxCount})</span><strong>${money(monthSales)}</strong></div>
          <div class="pnl-row pnl-negative"><span>(−) Costo de productos vendidos</span><strong>− ${money(monthCost)}</strong></div>
          <div class="pnl-row pnl-total ${grossProfit < 0 ? "is-loss" : "is-profit"}"><span>(=) Ganancia bruta (${pct(grossMarginPct)})</span><strong>${money(grossProfit)}</strong></div>
        </div>
      </article>
      <article class="panel kpi-panel">
        <div class="panel-heading"><div><h2>Recaudación por medio de pago</h2><p>Distribución de ingresos cobrados este mes</p></div></div>
        <div class="kpi-bars">${paymentRowsMarkup}</div>
      </article>
    </section>
    <section class="finance-kpi-grid section-spacer">
      <article class="panel kpi-panel">
        <div class="panel-heading"><div><h2>Productos más rentables del mes</h2><p>Mayor aporte a la utilidad bruta (venta menos costo)</p></div></div>
        <div class="analysis-list">${topProductsMarkup}</div>
      </article>
      <article class="panel kpi-panel">
        <div class="panel-heading"><div><h2>Distribución de gastos del mes</h2><p>Categorías con mayor peso en tus gastos operativos</p></div></div>
        <div class="kpi-bars">${expenseCategoriesMarkup}</div>
      </article>
    </section>
    <section class="panel finance-history section-spacer"><div class="panel-heading chart-panel-heading"><div><h2>Evolución de ganancias brutas, pérdidas y compras</h2><p>Ganancia bruta: ingresos netos menos costo de venta · pérdidas incluye mermas y gastos</p></div><div class="chart-range-switch" role="group" aria-label="Período del resumen financiero">${[3, 6, 12].map((range) => `<button class="chart-range-button ${financeRange === range ? "active" : ""}" data-finance-range="${range}" aria-pressed="${financeRange === range}">${range} meses</button>`).join("")}</div></div><div class="chart-legend finance-legend"><span><i class="legend-dot finance-earnings"></i>Ganancia bruta</span><span><i class="legend-dot negative"></i>Pérdidas</span><span><i class="legend-dot finance-purchases"></i>Compras</span></div><div class="chart-wrap finance-chart">${financeChart}</div></section>
    <h2 class="subheading">Gastos recientes</h2><article class="panel table-panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>FECHA</th><th>CATEGORÍA</th><th>DESCRIPCIÓN</th><th>MONTO</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
}

function modal(title, description, form) {
  $("#modal-root").innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><h2 id="modal-title">${title}</h2><p>${description}</p></div><button class="modal-close" data-action="close-modal" aria-label="Cerrar">×</button></div>${form}</section></div>`;
  $(".modal-backdrop").addEventListener("click", (event) => {
    if (event.target.classList.contains("modal-backdrop")) closeModal();
  });
  $("input, select, textarea", $(".modal"))?.focus();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function field(name, label, value = "", type = "text", required = false, extra = "") {
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${required ? "required" : ""} ${extra}></div>`;
}

function openProductForm(product = null) {
  const editing = Boolean(product);
  const form = `<form id="product-form" class="modal-form">
    ${field("product-name", "Nombre del producto", product?.name || "", "text", true)}
    <div class="form-row">${field("product-sku", "Código / SKU", product?.sku || "")}${field("product-category", "Categoría", product?.category || "")}</div>
    <div class="form-row">${field("product-barcode", "Código de barras", product?.barcode || "")}<div class="field"><label for="product-unit">Unidad de medida</label><select id="product-unit" name="unit">${["UN", "KG", "LT", "MT", "CAJA"].map((unit) => `<option ${unit === (product?.unit || "UN") ? "selected" : ""}>${unit}</option>`).join("")}</select></div></div>
    <div class="form-row">${field("product-net-price", "Precio neto (CLP)", product?.net_price ?? "", "number", true, 'min="0" step="1"')}${field("product-price", "Precio final (CLP)", product?.price ?? "", "number", true, 'min="0" step="1"')}</div>
    <div class="form-row">${field("product-cost", "Costo promedio (CLP)", product?.cost ?? "", "number", false, 'min="0" step="1"')}${field("product-stock", editing ? "Stock actual" : "Stock inicial", product?.stock ?? 0, "number", true, 'min="0" step="0.001"')}</div>
    <div class="form-row">${field("product-min-stock", "Stock mínimo", product?.min_stock ?? 0, "number", false, 'min="0" step="0.001"')}<label class="field"><span>Tratamiento tributario</span><span><input id="product-tax-exempt" name="tax_exempt" type="checkbox" ${product?.tax_exempt ? "checked" : ""}> Producto exento de IVA</span></label></div>
    <div class="field"><label for="product-description">Descripción</label><textarea id="product-description" name="description">${escapeHtml(product?.description || "")}</textarea></div>
    <div class="modal-actions"><button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button><button class="button button-primary button-small">${editing ? "Guardar cambios" : "Crear producto"}</button></div>
    <input type="hidden" name="product-id" value="${product?.id || ""}"></form>`;
  modal(editing ? "Editar producto" : "Nuevo producto", "Mantén actualizados los datos y el stock de tu catálogo.", form);
}

function openCustomerForm() {
  modal("Nuevo cliente", "Guarda sus datos de contacto y tributarios.", `<form id="customer-form" class="modal-form">${field("customer-name", "Nombre / razón social", "", "text", true)}<div class="form-row">${field("customer-rut", "RUT")}${field("customer-business", "Giro")}</div><div class="form-row">${field("customer-phone", "Teléfono")}${field("customer-email", "Correo", "", "email")}</div>${field("customer-address", "Dirección")}<div class="modal-actions"><button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button><button class="button button-primary button-small">Guardar cliente</button></div></form>`);
}

function openSupplierForm() {
  modal("Nuevo proveedor", "Guarda sus datos de contacto y tributarios.", `<form id="supplier-form" class="modal-form">${field("supplier-name", "Razón social", "", "text", true)}<div class="form-row">${field("supplier-rut", "RUT")}${field("supplier-contact", "Persona de contacto")}</div><div class="form-row">${field("supplier-phone", "Teléfono")}${field("supplier-email", "Correo", "", "email")}</div>${field("supplier-address", "Dirección")}<div class="modal-actions"><button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button><button class="button button-primary button-small">Guardar proveedor</button></div></form>`);
}

function openMovementForm(productId = "", supplierId = "", defaultType = "entry") {
  const products = query("SELECT id,name,stock FROM products ORDER BY name");
  const suppliers = query("SELECT id,name FROM suppliers ORDER BY name");
  if (!products.length) {
    notify("Primero agrega al menos un producto.", "error");
    return;
  }
  const productOptions = products.map((product) => `<option value="${product.id}" ${String(product.id) === String(productId) ? "selected" : ""}>${escapeHtml(product.name)} · ${product.stock} u.</option>`).join("");
  const supplierOptions = suppliers.map((supplier) => `<option value="${supplier.id}" ${String(supplier.id) === String(supplierId) ? "selected" : ""}>${escapeHtml(supplier.name)}</option>`).join("");
  const types = MOVEMENT_TYPES.map((type) => `<option value="${type.value}" ${type.value === defaultType ? "selected" : ""}>${type.label}</option>`).join("");
  modal("Movimiento de inventario", "Los movimientos quedan como auditoría de stock; las entradas con proveedor también registran una compra.", `<form id="movement-form" class="modal-form"><div class="field"><label for="movement-product">Producto</label><select id="movement-product" name="product_id">${productOptions}</select></div><div class="form-row"><div class="field"><label for="movement-type">Tipo</label><select id="movement-type" name="type">${types}</select></div>${field("movement-quantity", "Cantidad / stock final", "", "number", true, 'min="0" step="0.001"')}</div><div class="field"><label for="movement-supplier">Proveedor (opcional)</label><select id="movement-supplier" name="supplier_id"><option value="">Sin proveedor</option>${supplierOptions}</select></div><div class="form-row"><div class="field"><label for="movement-document">Documento de compra</label><select id="movement-document" name="purchase_document"><option>SIN_DOC</option><option>FACTURA</option><option>BOLETA</option><option>GUIA_DESPACHO</option></select></div>${field("movement-folio", "Folio de compra")}</div>${field("movement-cost", "Costo unitario neto (CLP)", "", "number", false, 'min="0" step="1"')}<div class="field"><label for="movement-note">Nota o motivo</label><input id="movement-note" name="note" placeholder="Ej.: compra, corrección, producto dañado"></div><div class="modal-actions"><button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button><button class="button button-primary button-small">Registrar movimiento</button></div></form>`);
  $("#movement-type").addEventListener("change", () => {
    const type = $("#movement-type").value;
    $('label[for="movement-quantity"]').textContent = type === "adjustment" ? "Nuevo stock final" : "Cantidad";
    $("#movement-supplier").disabled = type !== "entry" && type !== "supplier_return";
    $("#movement-document").disabled = type !== "entry";
    $("#movement-folio").disabled = type !== "entry";
    $("#movement-cost").disabled = type !== "entry";
  });
  $("#movement-type").dispatchEvent(new Event("change"));
}

function openExpenseForm() {
  modal("Registrar gasto", "Los gastos se restarán de tus ingresos en el balance mensual.", `<form id="expense-form" class="modal-form"><div class="form-row">${field("expense-category", "Categoría", "", "text", true)}${field("expense-amount", "Monto (CLP)", "", "number", true, 'min="1" step="1"')}</div>${field("expense-description", "Descripción", "", "text", true)}<div class="modal-actions"><button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button><button class="button button-primary button-small">Guardar gasto</button></div></form>`);
}

function saveProduct(form) {
  const data = new FormData(form);
  const product = {
    name: String(data.get("product-name")).trim(),
    sku: String(data.get("product-sku")).trim(),
    category: String(data.get("product-category")).trim(),
    barcode: String(data.get("product-barcode")).trim(),
    unit: String(data.get("unit")),
    netPrice: Number(data.get("product-net-price")),
    price: Number(data.get("product-price")),
    cost: Number(data.get("product-cost")) || 0,
    stock: Number(data.get("product-stock")),
    minStock: Number(data.get("product-min-stock")) || 0,
    taxExempt: data.has("tax_exempt") ? 1 : 0,
    description: String(data.get("description")).trim()
  };
  if (!product.name) throw new Error("El producto necesita un nombre.");
  if ([product.netPrice, product.price, product.cost].some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Los precios y costos en pesos chilenos deben ser números enteros iguales o mayores a cero.");
  }
  if ([product.stock, product.minStock].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("El stock debe ser un número válido igual o mayor a cero.");
  }
  if (["UN", "CAJA"].includes(product.unit) && (![product.stock, product.minStock].every(Number.isInteger))) {
    throw new Error("El stock de unidades y cajas debe ser un número entero.");
  }
  const id = Number(data.get("product-id"));
  const previous = id ? query("SELECT stock FROM products WHERE id=?", [id])[0] : null;
  if (id && !previous) throw new Error("No se encontró el producto que intentas editar.");
  const targetStock = product.stock;
  const initialStock = id ? previous.stock : 0;
  try {
    db.run("BEGIN TRANSACTION");
    if (id) {
      run(`UPDATE products SET name=?,sku=?,category=?,price=?,cost=?,stock=?,min_stock=?,
        barcode=?,unit=?,net_price=?,tax_exempt=?,description=? WHERE id=?`,
      [product.name, product.sku, product.category, product.price, product.cost, previous.stock, product.minStock,
        product.barcode, product.unit, product.netPrice, product.taxExempt, product.description, id]);
      if (targetStock !== initialStock) recordMovement(id, "adjustment", targetStock, "Ajuste desde ficha de producto");
    } else {
      run(`INSERT INTO products(name,sku,category,price,cost,stock,min_stock,barcode,unit,net_price,tax_exempt,description)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [product.name, product.sku, product.category, product.price, product.cost, 0, product.minStock,
        product.barcode, product.unit, product.netPrice, product.taxExempt, product.description]);
      const productId = query("SELECT id FROM products ORDER BY id DESC LIMIT 1")[0].id;
      if (targetStock > 0) recordMovement(productId, "entry", targetStock, "Stock inicial");
    }
    db.run("COMMIT");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch (rollbackError) { console.error(rollbackError); }
    throw error;
  }
  closeModal();
  render();
  notify(id ? "Producto actualizado." : "Producto creado.");
}

function recordMovement(productId, type, quantity, note, supplierId = null) {
  const product = query("SELECT stock,unit,cost FROM products WHERE id=?", [productId])[0];
  if (!product) throw new Error("El producto seleccionado ya no existe.");
  const before = Number(product.stock);
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("La cantidad debe ser un número válido igual o mayor a cero.");
  if (["UN", "CAJA"].includes(product.unit) && !Number.isInteger(amount)) {
    throw new Error("Los movimientos de unidades y cajas deben usar cantidades enteras.");
  }
  if (type !== "adjustment" && amount === 0) throw new Error("La cantidad del movimiento debe ser mayor a cero.");
  let delta = amount;
  if (type === "adjustment") {
    delta = amount - before;
  } else if (type === "loss" || type === "supplier_return") {
    delta = -amount;
  }
  if (type === "adjustment" && delta === 0) return;
  if (before + delta < 0) throw new Error("El movimiento supera el stock disponible.");
  const form = $("#movement-form");
  const movementData = form ? new FormData(form) : null;
  const enteredCost = movementData?.get("movement-cost");
  const cost = enteredCost !== null && enteredCost !== undefined && String(enteredCost).trim() !== ""
    ? Number(enteredCost)
    : Number(product.cost) || 0;
  if (!Number.isInteger(cost) || cost < 0) throw new Error("El costo en pesos chilenos debe ser un número entero igual o mayor a cero.");
  run(`INSERT INTO stock_movements
    (product_id,supplier_id,type,quantity,note,date,cost,purchase_document,purchase_folio,purchase_cost)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
  [productId, supplierId || null, type, delta, note, localDateTime(), cost,
    movementData?.get("purchase_document") || "SIN_DOC",
    String(movementData?.get("movement-folio") || "").trim() || null, cost]);
}

function saveMovement(form) {
  const data = new FormData(form);
  const productId = Number(data.get("product_id"));
  const type = String(data.get("type"));
  recordMovement(productId, type, Number(data.get("movement-quantity")), String(data.get("note")).trim(), data.get("supplier_id"));
  closeModal();
  render();
  notify("Movimiento de inventario registrado.");
}

function saveSale() {
  if (!saleCart.length) throw new Error("Agrega al menos un producto a la venta.");
  const lineTotals = saleCart.map((item) => Math.round(item.price * item.quantity));
  const lineNetValues = saleCart.map((item, index) => item.taxExempt
    ? lineTotals[index]
    : Math.round(lineTotals[index] / 1.19));
  const subtotal = lineTotals.reduce((sum, lineTotal) => sum + lineTotal, 0);
  const discount = Number(saleDiscount) || 0;
  if (!Number.isInteger(discount) || discount < 0 || discount > subtotal) throw new Error("El descuento debe ser un monto entero entre $0 y el subtotal.");
  const total = subtotal - discount;
  const netBeforeDiscount = lineNetValues.reduce((sum, netValue) => sum + netValue, 0);
  const netAfterDiscount = subtotal
    ? Math.max(0, netBeforeDiscount - Math.round(discount * netBeforeDiscount / subtotal))
    : 0;
  const taxAfterDiscount = total - netAfterDiscount;
  const lineNetRevenue = DatabaseLayer.allocateAmount(netAfterDiscount, lineNetValues);
  const isSplitPayment = paymentRows.length > 1;
  const isSingleNonCash = !isSplitPayment && paymentRows[0]?.type !== "Efectivo";
  const payments = paymentRows.map((payment) => ({
    type: payment.type,
    amount: isSingleNonCash ? total : Number(payment.amount),
    reference: null
  }));
  if (payments.some((payment) => !Number.isInteger(payment.amount) || payment.amount < 0)) throw new Error("Cada medio de pago debe tener un monto entero válido.");
  const paymentTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const otherPaymentTotal = payments.reduce((sum, payment) => sum + (payment.type === "Efectivo" ? 0 : payment.amount), 0);
  const cashTotal = paymentTotal - otherPaymentTotal;
  if (otherPaymentTotal > total) throw new Error("Los pagos que no son en efectivo no pueden superar el total de la venta.");
  if (paymentTotal < total) throw new Error("El monto ingresado no cubre el total de la venta.");
  if (paymentTotal > total && cashTotal === 0) throw new Error("Solo se puede dar vuelto cuando el pago incluye efectivo.");
  const cashToApply = total - otherPaymentTotal;
  let cashRemaining = cashToApply;
  const recordedPayments = payments.map((payment) => {
    if (payment.type !== "Efectivo") return payment;
    const appliedAmount = Math.min(payment.amount, cashRemaining);
    cashRemaining -= appliedAmount;
    return { ...payment, amount: appliedAmount };
  });
  const originalItems = editingSaleId
    ? query("SELECT product_id, SUM(quantity) AS quantity FROM sale_items WHERE sale_id=? GROUP BY product_id", [editingSaleId])
    : [];
  const originalQtyByProduct = new Map(originalItems.map((row) => [Number(row.product_id), Number(row.quantity) || 0]));
  for (const item of saleCart) {
    const product = query("SELECT stock FROM products WHERE id=?", [item.id])[0];
    const availableStock = (Number(product?.stock) || 0) + (originalQtyByProduct.get(Number(item.id)) || 0);
    if (!product || availableStock < item.quantity) throw new Error(`Stock insuficiente para «${item.name}». Actualiza la cantidad antes de completar la venta.`);
    if (["UN", "CAJA"].includes(item.unit) && !Number.isInteger(item.quantity)) throw new Error(`La cantidad de «${item.name}» debe ser entera.`);
  }
  const customerId = saleCustomerId || null;
  const wasEditing = Boolean(editingSaleId);
  try {
    db.run("BEGIN TRANSACTION");
    let saleId = editingSaleId;
    if (editingSaleId) {
      for (const oldItem of originalItems) {
        const qty = Number(oldItem.quantity) || 0;
        if (qty > 0) {
          run("INSERT INTO stock_movements(product_id,type,quantity,note,date) VALUES(?,'adjustment',?,?,?)", [oldItem.product_id, qty, `Reversión por edición de venta #${editingSaleId}`, localDateTime()]);
        }
      }
      run("DELETE FROM sale_items WHERE sale_id=?", [editingSaleId]);
      run("DELETE FROM payments WHERE sale_id=?", [editingSaleId]);
      run(`UPDATE sales SET customer_id=?,subtotal=?,discount=?,total=?,status='completed',net_subtotal=?,tax=?,document_type=?,folio=? WHERE id=?`,
        [customerId, subtotal, discount, total, netAfterDiscount, taxAfterDiscount, saleDocumentType, saleFolio || null, editingSaleId]);
    } else {
      run(`INSERT INTO sales(customer_id,date,subtotal,discount,total,status,net_subtotal,tax,document_type,folio)
        VALUES(?,?,?,?,?,'completed',?,?,?,?)`,
      [customerId, localDateTime(), subtotal, discount, total, netAfterDiscount, taxAfterDiscount, saleDocumentType, saleFolio || null]);
      saleId = query("SELECT id FROM sales ORDER BY id DESC LIMIT 1")[0].id;
    }
    for (let index = 0; index < saleCart.length; index += 1) {
      const item = saleCart[index];
      run(`INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total,unit_cost,net_revenue)
        VALUES(?,?,?,?,?,?,?,?)`,
      [saleId, item.id, item.name, item.quantity, item.price, lineTotals[index], item.cost, lineNetRevenue[index]]);
      run("INSERT INTO stock_movements(product_id,type,quantity,note,date) VALUES(?,'sale',?,?,?)", [item.id, -item.quantity, wasEditing ? `Venta #${saleId} (editada)` : `Venta #${saleId}`, localDateTime()]);
    }
    for (const payment of recordedPayments) {
      if (payment.amount > 0) run("INSERT INTO payments(sale_id,type,amount,reference) VALUES(?,?,?,?)", [saleId, payment.type, payment.amount, payment.reference || null]);
    }
    db.run("COMMIT");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch (rollbackError) { console.error(rollbackError); }
    throw error;
  }
  saleCart = [];
  paymentRows = [{ type: "Efectivo", amount: "" }];
  saleCustomerId = "";
  saleDiscount = "0";
  saleDocumentType = "BOLETA";
  saleFolio = "";
  editingSaleId = null;
  render();
  notify(wasEditing ? "Venta actualizada. El historial y el stock se actualizaron." : "Venta registrada. El historial y el stock se actualizaron.");
}

function startEditSale(saleId) {
  const sale = query("SELECT * FROM sales WHERE id=?", [saleId])[0];
  if (!sale) throw new Error("No se encontró la venta seleccionada.");
  const items = query(`SELECT si.product_id,si.product_name,si.quantity,si.unit_price,si.unit_cost,
      p.stock,p.unit,p.net_price,p.tax_exempt
    FROM sale_items si LEFT JOIN products p ON p.id=si.product_id
    WHERE si.sale_id=? ORDER BY si.id`, [saleId]);
  const payments = query("SELECT type,amount,reference FROM payments WHERE sale_id=? ORDER BY id", [saleId]);
  const qtyByProduct = new Map();
  for (const item of items) {
    qtyByProduct.set(Number(item.product_id), (qtyByProduct.get(Number(item.product_id)) || 0) + Number(item.quantity));
  }
  editingSaleId = Number(sale.id);
  saleCart = items.map((item) => {
    const restoredStock = (Number(item.stock) || 0) + (qtyByProduct.get(Number(item.product_id)) || 0);
    return {
      id: Number(item.product_id),
      name: item.product_name,
      price: Number(item.unit_price),
      stock: restoredStock,
      unit: item.unit || "UN",
      cost: Number(item.unit_cost) || 0,
      netPrice: Number(item.net_price) || Number(item.unit_price),
      taxExempt: Boolean(item.tax_exempt),
      quantity: Number(item.quantity)
    };
  });
  paymentRows = payments.length
    ? payments.map((p) => ({ type: p.type, amount: String(p.amount), reference: p.reference || "" }))
    : [{ type: "Efectivo", amount: String(sale.total) }];
  saleCustomerId = sale.customer_id ? String(sale.customer_id) : "";
  saleDiscount = String(sale.discount || 0);
  saleDocumentType = sale.document_type || "BOLETA";
  saleFolio = sale.folio || "";
  currentView = "sales";
  searchValue = "";
  render();
  notify(`Editando la venta #${sale.id}.`);
}

function cancelEditSale() {
  saleCart = [];
  paymentRows = [{ type: "Efectivo", amount: "" }];
  saleCustomerId = "";
  saleDiscount = "0";
  saleDocumentType = "BOLETA";
  saleFolio = "";
  editingSaleId = null;
  render();
  notify("Edición de venta cancelada.");
}

function openDeleteSaleModal(saleId) {
  const sale = query(`SELECT s.id,s.date,s.total,c.name AS customer FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`, [saleId])[0];
  if (!sale) throw new Error("No se encontró la venta seleccionada.");
  const content = `<div class="modal-form">
    <p class="confirm-message">¿Estás seguro de eliminar la venta <strong>#${sale.id}</strong> por <strong>${money(sale.total)}</strong> (${escapeHtml(sale.customer || "Venta sin cliente")})?</p>
    <p class="confirm-note">Esta acción eliminará el registro de la venta y devolverá los productos al stock del inventario.</p>
    <div class="modal-actions">
      <button type="button" class="button button-muted button-small" data-action="close-modal">Cancelar</button>
      <button type="button" class="button button-danger button-small" data-action="delete-sale" data-id="${sale.id}">Sí, eliminar venta</button>
    </div>
  </div>`;
  modal("¿Estás seguro de eliminar la venta?", "Confirma antes de borrar definitivamente este registro.", content);
}

function deleteSale(saleId) {
  const sale = query("SELECT id,status FROM sales WHERE id=?", [saleId])[0];
  if (!sale) throw new Error("No se encontró la venta que intentas eliminar.");
  const items = query("SELECT product_id, SUM(quantity) AS quantity FROM sale_items WHERE sale_id=? GROUP BY product_id", [saleId]);
  try {
    db.run("BEGIN TRANSACTION");
    if (sale.status === "completed") {
      for (const item of items) {
        const qty = Number(item.quantity) || 0;
        if (qty > 0) {
          run("INSERT INTO stock_movements(product_id,type,quantity,note,date) VALUES(?,'adjustment',?,?,?)", [item.product_id, qty, `Devolución de stock por eliminación de venta #${saleId}`, localDateTime()]);
        }
      }
    }
    run("DELETE FROM sales WHERE id=?", [saleId]);
    db.run("COMMIT");
  } catch (error) {
    try { db.run("ROLLBACK"); } catch (rollbackError) { console.error(rollbackError); }
    throw error;
  }
  if (editingSaleId === Number(saleId)) {
    saleCart = [];
    paymentRows = [{ type: "Efectivo", amount: "" }];
    saleCustomerId = "";
    saleDiscount = "0";
    saleDocumentType = "BOLETA";
    saleFolio = "";
    editingSaleId = null;
  }
  closeModal();
  render();
  notify(`Venta #${saleId} eliminada y stock restaurado.`);
}

function saveCustomer(form) {
  const data = new FormData(form);
  const name = String(data.get("customer-name")).trim();
  if (!name) throw new Error("El cliente necesita un nombre.");
  run(`INSERT INTO customers(name,phone,email,rut,business,address)
    VALUES(?,?,?,?,?,?)`, [name, String(data.get("customer-phone")).trim(), String(data.get("customer-email")).trim(),
    String(data.get("customer-rut")).trim(), String(data.get("customer-business")).trim(), String(data.get("customer-address")).trim()]);
  closeModal();
  render();
  notify("Cliente guardado.");
}

function saveSupplier(form) {
  const data = new FormData(form);
  const name = String(data.get("supplier-name")).trim();
  if (!name) throw new Error("El proveedor necesita un nombre.");
  run(`INSERT INTO suppliers(name,phone,email,rut,contact,address)
    VALUES(?,?,?,?,?,?)`, [name, String(data.get("supplier-phone")).trim(), String(data.get("supplier-email")).trim(),
    String(data.get("supplier-rut")).trim(), String(data.get("supplier-contact")).trim(), String(data.get("supplier-address")).trim()]);
  closeModal();
  render();
  notify("Proveedor guardado.");
}

function saveExpense(form) {
  const data = new FormData(form);
  const amount = Number(data.get("expense-amount"));
  const category = String(data.get("expense-category")).trim();
  const description = String(data.get("expense-description")).trim();
  if (!category || !description || !Number.isInteger(amount) || amount <= 0) throw new Error("Completa la categoría, descripción y un monto entero mayor a cero.");
  run("INSERT INTO expenses(category,description,amount,date) VALUES(?,?,?,?)", [category, description, amount, localDateTime()]);
  closeModal();
  render();
  notify("Gasto registrado.");
}

function addProductToCart(productId, keepFocusSelector = null) {
  const product = query("SELECT id,name,price,stock,unit,cost,net_price,tax_exempt FROM products WHERE id=?", [productId])[0];
  if (!product) throw new Error("No se encontró el producto.");
  const originalQty = editingSaleId
    ? Number(query("SELECT COALESCE(SUM(quantity),0) AS quantity FROM sale_items WHERE sale_id=? AND product_id=?", [editingSaleId, productId])[0]?.quantity) || 0
    : 0;
  const availableStock = Number(product.stock) + originalQty;
  const item = saleCart.find((entry) => entry.id === product.id);
  const step = product.unit === "UN" || product.unit === "CAJA" ? 1 : 0.25;
  if (availableStock < (item?.quantity || 0) + step) throw new Error(`No hay suficiente stock para agregar más de «${product.name}».`);
  if (item) {
    item.stock = availableStock;
    item.quantity += step;
  } else saleCart.push({
    id: product.id, name: product.name, price: product.price, stock: availableStock,
    unit: product.unit, cost: product.cost, netPrice: product.net_price,
    taxExempt: Boolean(product.tax_exempt), quantity: step
  });
  render();
  if (keepFocusSelector) $(keepFocusSelector)?.focus();
}

function addProductByBarcode(code, keepSearchFocus = true) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return false;
  const normalized = cleanCode.toLocaleLowerCase("es");
  const product = query("SELECT id,name,barcode,sku FROM products WHERE active=1").find((item) =>
    String(item.barcode || "").trim().toLocaleLowerCase("es") === normalized ||
    String(item.sku || "").trim().toLocaleLowerCase("es") === normalized
  );
  if (!product) {
    notify(`No se encontró ningún producto con el código «${cleanCode}».`, "error");
    if (keepSearchFocus) {
      const searchInput = $("#table-search");
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
    return false;
  }
  searchValue = "";
  addProductToCart(product.id, keepSearchFocus ? "#table-search" : null);
  notify(`Agregado: ${product.name}`);
  return true;
}

function bindEvents() {
  $("#create-database").addEventListener("click", createDatabase);
  $("#open-database").addEventListener("click", openFilePicker);
  $("#change-database").addEventListener("click", openFilePicker);
  for (const button of document.querySelectorAll(".sql-console-link, .sql-console-mobile-link")) {
    button.addEventListener("click", () => {
      currentView = "sql-console";
      render();
    });
  }
  $("#save-database").addEventListener("click", saveDatabase);
  $("#exit-application").addEventListener("click", (event) => {
    exitToWelcome(event.currentTarget).catch((error) => {
      event.currentTarget.disabled = false;
      showError(error, "No se pudo volver a la página de inicio.");
    });
  });
  $("#database-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(db|sqlite|sqlite3)$/i.test(file.name)) {
      notify("Elige un archivo con extensión .db, .sqlite o .sqlite3.", "error");
      event.target.value = "";
      return;
    }
    await openDatabaseBytes(await file.arrayBuffer(), file.name);
    event.target.value = "";
  });
  $(".main-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    currentView = button.dataset.view;
    searchValue = "";
    customerHistoryId = null;
    render();
  });
  $("#page-content").addEventListener("click", (event) => {
    const rangeButton = event.target.closest("[data-chart-range]");
    if (rangeButton) {
      dashboardRange = rangeButton.dataset.chartRange;
      render();
      return;
    }
    const financeRangeButton = event.target.closest("[data-finance-range]");
    if (financeRangeButton) {
      financeRange = Number(financeRangeButton.dataset.financeRange);
      render();
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      currentView = viewButton.dataset.view;
      searchValue = "";
      render();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === "new-product") openProductForm();
      else if (action === "export-inventory") exportInventory();
      else if (action === "export-sales-period") {
        exportSalesPeriod($("#sales-period-start").value, $("#sales-period-end").value);
      } else if (action === "export-sales-month") exportSalesMonth(Number(button.dataset.offset));
      else if (action === "edit-product") openProductForm(query("SELECT * FROM products WHERE id=?", [Number(button.dataset.id)])[0]);
      else if (action === "new-customer") openCustomerForm();
      else if (action === "new-supplier") openSupplierForm();
      else if (action === "new-movement") openMovementForm("", button.dataset.supplierId || "");
      else if (action === "movement-for-product") openMovementForm(button.dataset.id);
      else if (action === "restock-product") openMovementForm(button.dataset.id, "", "entry");
      else if (action === "new-expense") openExpenseForm();
      else if (action === "close-modal") closeModal();
      else if (action === "customer-history") {
        customerHistoryId = Number(button.dataset.id);
        render();
      } else if (action === "back-customers") {
        customerHistoryId = null;
        render();
      } else if (action === "add-cart") addProductToCart(Number(button.dataset.id));
      else if (action === "edit-sale") startEditSale(Number(button.dataset.id));
      else if (action === "cancel-edit-sale") cancelEditSale();
      else if (action === "confirm-delete-sale") openDeleteSaleModal(Number(button.dataset.id));
      else if (action === "remove-cart-item") {
        saleCart = saleCart.filter((entry) => entry.id !== Number(button.dataset.id));
        render();
      } else if (action === "cart-qty") {
        const item = saleCart.find((entry) => entry.id === Number(button.dataset.id));
        if (item) {
          item.quantity += Number(button.dataset.change);
          if (item.quantity <= 0) saleCart = saleCart.filter((entry) => entry !== item);
          render();
        }
      } else if (action === "add-payment") {
        paymentRows.push({ type: "Transferencia", amount: "" });
        render();
      } else if (action === "remove-payment") {
        const index = Number(button.dataset.index);
        if (index > 0 && index < paymentRows.length) {
          paymentRows.splice(index, 1);
          render();
        }
      } else if (action === "complete-sale") saveSale();
      else if (action === "run-sql") executeSqlConsole();
      else if (action === "clear-sql") {
        sqlConsoleInput = "";
        sqlConsoleOutput = null;
        render();
      }
    } catch (error) {
      showError(error, "No se pudo completar la acción.");
    }
  });
  $("#page-content").addEventListener("input", (event) => {
    if (event.target.id === "sql-console-input") sqlConsoleInput = event.target.value;
    if (event.target.id === "table-search") {
      searchValue = event.target.value;
      const selection = event.target.selectionStart;
      render();
      const input = $("#table-search");
      input?.focus();
      input?.setSelectionRange(selection, selection);
    }
    if (event.target.id === "sale-discount" || event.target.matches("[data-payment-amount]")) {
      const input = event.target;
      const rawValue = input.value;
      const oldCaret = input.selectionStart ?? rawValue.length;
      const value = rawValue.replace(/\D/g, "");
      const caret = rawValue.slice(0, oldCaret).replace(/\D/g, "").length;
      input.value = value;
      if (input.id === "sale-discount") saleDiscount = value;
      if (input.matches("[data-payment-amount]")) paymentRows[Number(input.dataset.paymentAmount)].amount = value;
      const inputId = input.id;
      const paymentIndex = input.dataset.paymentAmount;
      render();
      const target = inputId === "sale-discount"
        ? $("#sale-discount")
        : $(`[data-payment-amount="${paymentIndex}"]`);
      target?.focus();
      target?.setSelectionRange(caret, caret);
    }
  });
  $("#page-content").addEventListener("change", (event) => {
    if (event.target.matches("[data-payment-type]")) {
      paymentRows[Number(event.target.dataset.paymentType)].type = event.target.value;
      render();
    }
    if (event.target.id === "sale-customer") saleCustomerId = event.target.value;
    if (event.target.id === "sale-document-type") saleDocumentType = event.target.value;
    if (event.target.id === "sale-folio") saleFolio = event.target.value.trim();
    if (event.target.matches("[data-cart-quantity]")) {
      const item = saleCart.find((entry) => entry.id === Number(event.target.dataset.cartQuantity));
      const quantity = Number(event.target.value);
      if (!item || !Number.isFinite(quantity) || quantity <= 0 || quantity > item.stock) {
        notify("La cantidad debe ser mayor a cero y no superar el stock disponible.", "error");
        render();
        return;
      }
      if (["UN", "CAJA"].includes(item.unit) && !Number.isInteger(quantity)) {
        notify("La cantidad de unidades y cajas debe ser entera.", "error");
        render();
        return;
      }
      item.quantity = quantity;
      render();
    }
  });
  $("#modal-root").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      if (event.target.id === "product-form") saveProduct(event.target);
      else if (event.target.id === "movement-form") saveMovement(event.target);
      else if (event.target.id === "customer-form") saveCustomer(event.target);
      else if (event.target.id === "supplier-form") saveSupplier(event.target);
      else if (event.target.id === "expense-form") saveExpense(event.target);
    } catch (error) {
      showError(error, "No se pudo guardar la información.");
    }
  });
  $("#modal-root").addEventListener("click", (event) => {
    if (event.target.closest('[data-action="close-modal"]')) {
      closeModal();
      return;
    }
    const deleteButton = event.target.closest('[data-action="delete-sale"]');
    if (deleteButton) {
      try {
        deleteSale(Number(deleteButton.dataset.id));
      } catch (error) {
        showError(error, "No se pudo eliminar la venta.");
      }
    }
  });
  $("#page-content").addEventListener("keydown", (event) => {
    if (event.target.id === "sql-console-input" && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      executeSqlConsole();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.target.id === "table-search" && currentView === "sales") {
      const code = event.target.value.trim();
      if (!code) return;
      event.preventDefault();
      try {
        addProductByBarcode(code, true);
      } catch (error) {
        showError(error, "No se pudo agregar el producto escaneado.");
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (currentView !== "sales" || !databaseReady() || $("#modal-root").children.length > 0) return;
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const now = performance.now();
    if (event.key === "Enter") {
      if (barcodeBuffer.length >= 3 && now - barcodeLastKeyTime < 150) {
        event.preventDefault();
        const scanned = barcodeBuffer;
        barcodeBuffer = "";
        try {
          addProductByBarcode(scanned, true);
        } catch (error) {
          showError(error, "No se pudo agregar el producto escaneado.");
        }
      } else {
        barcodeBuffer = "";
      }
      return;
    }
    if (event.key.length === 1) {
      if (now - barcodeLastKeyTime > 120) barcodeBuffer = "";
      barcodeBuffer += event.key;
      barcodeLastKeyTime = now;
    }
  });
}

bindEvents();
restoreAutoSavedDatabase();
