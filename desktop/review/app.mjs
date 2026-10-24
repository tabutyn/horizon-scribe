const $ = (id) => document.getElementById(id);
const identity = (row) => JSON.stringify([row.setId, row.image]);
let catalog,
  selected = [],
  revision = 0,
  page = 0,
  saving = false,
  dirty = false,
  failed = false;
const pageSize = 12;
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
      $("status").textContent = "Saving local selection…";
      const result = await json("/api/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection(), selectionRevision: revision }),
      });
      revision = result.selectionRevision;
    }
    $("status").textContent = "Saved locally as next-batch.json";
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
function toggle(row) {
  const index = selected.findIndex((item) => identity(item) === identity(row));
  if (index >= 0) selected.splice(index, 1);
  else {
    if (selected.length >= 500) {
      $("status").textContent = "Maximum 500 images per round.";
      return;
    }
    selected.push(row);
  }
  change();
}
function render() {
  const keys = new Set(selected.map(identity));
  const rows = catalog.images.filter(
    (row) =>
      (!$("set").value || row.setId === $("set").value) &&
      row.image.toLowerCase().includes($("search").value.toLowerCase()) &&
      (!$("pending").checked || !row.approved) &&
      (!$("selected-only").checked || keys.has(identity(row))),
  );
  rows.sort(
    (a, b) =>
      ($("sort").value === "priority" ? b.priority - a.priority : 0) ||
      a.setId.localeCompare(b.setId) ||
      a.image.localeCompare(b.image),
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages - 1);
  $("grid").replaceChildren();
  for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const chosen = keys.has(identity(row)),
      button = element("button", undefined, "card");
    button.setAttribute("aria-pressed", String(chosen));
    button.setAttribute(
      "aria-label",
      `${chosen ? "Remove" : "Select"} ${row.setId}/${row.image}`,
    );
    const img = element("img");
    img.src = `/media/${row.index}.${$("overlay").checked ? "overlay" : "photo"}.jpg`;
    img.alt = `${row.mode === "prediction" ? "Prediction overlay" : "Base mask preview"} for ${row.image}`;
    img.loading = "lazy";
    const caption = element("span", undefined, "caption");
    caption.append(
      element("strong", row.image),
      element("small", `${row.setLabel} · ${row.width} × ${row.height}`),
      element(
        "small",
        `${row.mode} · priority ${row.priority.toFixed(3)}${row.approved ? " · approved" : ""}`,
      ),
      element(
        "span",
        chosen ? "✓ Selected" : "＋ Add to round",
        chosen ? "chosen" : "",
      ),
    );
    button.append(img, caption);
    button.onclick = () => toggle(row);
    $("grid").append(button);
  }
  if (!rows.length)
    $("grid").append(element("p", "No images match these filters."));
  $("previous").disabled = page === 0;
  $("next").disabled = page >= pages - 1;
  $("page").textContent = `${page + 1} / ${pages} · ${rows.length} images`;
  $("count").textContent = selected.length;
  $("download").disabled = !selected.length;
  $("queue").replaceChildren();
  selected.forEach((row, index) => {
    const li = element("li", `${index + 1}. ${row.setId} / ${row.image}`),
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
for (const id of [
  "set",
  "search",
  "sort",
  "overlay",
  "pending",
  "selected-only",
])
  $(id).addEventListener("input", () => {
    page = 0;
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
  selected = catalog.selection.images;
  revision = catalog.selectionRevision;
  const sets = new Map(catalog.images.map((row) => [row.setId, row.setLabel]));
  for (const [id, label] of sets) {
    const option = element("option", label);
    option.value = id;
    $("set").append(option);
  }
  $("dataset").textContent =
    `Dataset ${catalog.datasetId} · ${catalog.images.length} images · status: ${catalog.reviewStatus} · built ${catalog.generatedAt}`;
  $("status").textContent = selected.length
    ? "Restored your saved selection."
    : "Select images to begin.";
  render();
} catch (error) {
  $("status").textContent = error.message;
}
