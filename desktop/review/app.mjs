const $ = (id) => document.getElementById(id);
const identity = (row) => JSON.stringify([row.setId, row.image]);
let catalog,
  selected = [],
  revision = 0,
  page = 0,
  saving = false,
  dirty = false,
  failed = false;

async function json(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function selection() {
  return {
    schema: "horizon-scribe-next-batch-source/v1",
    datasetId: catalog.datasetId,
    runId: catalog.runId,
    modelId: catalog.modelId,
    predictionSetId: catalog.predictionSetId,
    images: selected.map((row, rank) => ({
      setId: row.setId,
      image: row.image,
      rank,
    })),
  };
}

async function persist() {
  dirty = true;
  if (saving || failed) return;
  saving = true;
  try {
    while (dirty) {
      dirty = false;
      const result = await json("/api/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection(), selectionRevision: revision }),
      });
      revision = result.selectionRevision;
    }
    $("status").textContent = "";
  } catch (error) {
    failed = true;
    dirty = true;
    $("status").textContent =
      `${error.message}. Download your selection before reloading.`;
  } finally {
    saving = false;
  }
}

function change() {
  render();
  void persist();
}

function choose(row) {
  const previous = selected.findIndex(
    (item) => item.sheetIndex === row.sheetIndex,
  );
  if (previous >= 0 && identity(selected[previous]) === identity(row))
    selected.splice(previous, 1);
  else if (previous >= 0) selected.splice(previous, 1, row);
  else selected.push(row);
  change();
}

function renderQueue() {
  $("count").textContent = selected.length;
  $("download").disabled = !selected.length;
  $("queue").replaceChildren();
  selected.forEach((row, index) => {
    const li = element(
        "li",
        `Sheet ${row.sheetIndex + 1}, tile ${row.sheetSlot + 1} · ${row.setId} / ${row.image}`,
      ),
      controls = element("div", undefined, "controls");
    for (const [text, delta] of [
      ["↑", -1],
      ["↓", 1],
      ["Remove", 0],
    ]) {
      const button = element("button", text);
      button.setAttribute(
        "aria-label",
        `${text === "Remove" ? "Remove" : delta < 0 ? "Move up" : "Move down"} ${row.image}`,
      );
      button.disabled =
        delta !== 0 && (index + delta < 0 || index + delta >= selected.length);
      button.onclick = () => {
        if (!delta) selected.splice(index, 1);
        else
          [selected[index], selected[index + delta]] = [
            selected[index + delta],
            selected[index],
          ];
        change();
      };
      controls.append(button);
    }
    li.append(controls);
    $("queue").append(li);
  });
}

function render() {
  const pages = catalog.sheets.length;
  page = Math.max(0, Math.min(page, Math.max(0, pages - 1)));
  $("sheet").replaceChildren();
  if (!pages) {
    $("sheet").append(
      element("p", "No unapproved images remain in this review bundle."),
    );
  } else {
    const sheet = catalog.sheets[page],
      frame = element("div", undefined, "sheet-frame"),
      image = element("img", undefined, "sheet-image"),
      hotspots = element("div", undefined, "sheet-hotspots");
    image.src = `/media/sheet-${sheet.index}.${$("overlay").checked ? "overlay" : "photo"}.jpg`;
    image.alt = `Pre-rendered 4 by 4 ${$("overlay").checked ? "inferred-label" : "source-photo"} review sheet ${sheet.index + 1}`;
    for (const imageIndex of sheet.imageIndexes) {
      const row = catalog.images[imageIndex],
        chosen = selected.some((item) => identity(item) === identity(row)),
        button = element("button", undefined, "tile-button"),
        number = element("span", String(row.sheetSlot + 1), "tile-number");
      button.type = "button";
      button.setAttribute("aria-pressed", String(chosen));
      button.setAttribute(
        "aria-label",
        `${chosen ? "Remove" : "Select"} sheet ${sheet.index + 1} tile ${row.sheetSlot + 1}: ${row.setId}/${row.image}`,
      );
      button.title = `${row.setLabel} · ${row.image} · priority ${row.priority.toFixed(3)}`;
      button.append(number);
      button.onclick = () => choose(row);
      hotspots.append(button);
    }
    frame.append(image, hotspots);
    $("sheet").append(frame);
  }
  $("previous").disabled = page === 0 || !pages;
  $("next").disabled = !pages || page >= pages - 1;
  $("page").textContent = pages
    ? `Sheet ${page + 1} / ${pages}`
    : "0 review sheets";
  renderQueue();
}

$("overlay").addEventListener("input", () => {
  if (catalog) render();
});
$("previous").onclick = () => {
  page--;
  render();
};
$("next").onclick = () => {
  page++;
  render();
};
$("selection-summary").onclick = () => {
  $("selection-dialog").showModal();
};
$("download").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(selection(), null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = element("a");
  link.href = url;
  link.download = "next-batch.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener("beforeunload", (event) => {
  if (saving || dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

try {
  catalog = await json("/api/catalog");
  const rows = new Map(catalog.images.map((row) => [identity(row), row]));
  selected = catalog.selection.images
    .map((row) => rows.get(identity(row)))
    .filter(Boolean);
  revision = catalog.selectionRevision;
  $("status").textContent = "";
  render();
} catch (error) {
  $("status").textContent = error.message;
}
