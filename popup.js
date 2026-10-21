const enableToggle = document.getElementById("enable-toggle");

chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) enableToggle.checked = data.enabled;
});

enableToggle.addEventListener("change", () => {
	chrome.storage.sync.set({ enabled: enableToggle.checked });
});
