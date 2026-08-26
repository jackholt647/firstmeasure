const fields = ["endpointUrl", "emailTrackerUrl", "leadLookupUrl", "leadLookupCode", "sharedSecret", "defaultSubject", "defaultBody", "templates", "sampleReports"];
const jsonFields = new Set(["templates", "sampleReports"]);

async function load() {
  const values = await chrome.storage.sync.get(fields);
  for (const field of fields) {
    const node = document.getElementById(field);
    node.value = jsonFields.has(field)
      ? JSON.stringify(values[field] || [], null, 2)
      : values[field] || "";
  }
}

async function save() {
  const next = {};
  for (const field of fields) {
    const value = document.getElementById(field).value.trim();
    if (jsonFields.has(field)) {
      try {
        next[field] = value ? JSON.parse(value) : [];
      } catch (error) {
        document.getElementById("status").textContent = `${field} is not valid JSON.`;
        return;
      }
    } else {
      next[field] = value;
    }
  }
  await chrome.storage.sync.set(next);
  const status = document.getElementById("status");
  status.textContent = "Saved.";
  window.setTimeout(() => {
    status.textContent = "";
  }, 2000);
}

document.getElementById("save").addEventListener("click", save);
load();
