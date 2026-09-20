const DEFAULTS = {
  showButton: true,
  clickToPause: true,
  dragAnywhere: true,
  keepAspect: true,
  skipSeconds: 10,
  buttonPosition: "left",
};

const checkboxes = ["showButton", "clickToPause", "dragAnywhere", "keepAspect"];

chrome.storage.sync.get(DEFAULTS, (stored) => {
  for (const id of checkboxes) {
    document.getElementById(id).checked = Boolean(stored[id]);
  }
  document.getElementById("skipSeconds").value = String(stored.skipSeconds);
  document.getElementById("buttonPosition").value = stored.buttonPosition;
});

for (const id of checkboxes) {
  document.getElementById(id).addEventListener("change", (e) => {
    chrome.storage.sync.set({ [id]: e.target.checked });
  });
}

document.getElementById("skipSeconds").addEventListener("change", (e) => {
  chrome.storage.sync.set({ skipSeconds: Number(e.target.value) });
});

document.getElementById("buttonPosition").addEventListener("change", (e) => {
  chrome.storage.sync.set({ buttonPosition: e.target.value });
});
