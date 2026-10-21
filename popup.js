const enableToggle = document.getElementById("enable-toggle");
const resetBtn = document.getElementById("reset-btn");

chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) enableToggle.checked = data.enabled;
});

enableToggle.addEventListener("change", () => {
	chrome.storage.sync.set({ enabled: enableToggle.checked });
});

resetBtn.addEventListener("click", () => {
	chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
		if (tabs[0]) {
			chrome.tabs.sendMessage(tabs[0].id, { action: "RESET_ARRAYS" });
		}
	});
});
