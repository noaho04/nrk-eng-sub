chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "translate") return;

  (async () => {
    try {
      const url = new URL(
        "https://translate.googleapis.com/translate_a/single"
      );

      url.searchParams.set("client", "gtx");
      url.searchParams.set("sl", "no");
      url.searchParams.set("tl", "en");
      url.searchParams.set("dt", "t");
      url.searchParams.set("q", message.text);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Translate HTTP ${response.status}`);
      }

      const data = await response.json();

      sendResponse({
        text: data[0].map(part => part[0]).join("").trim()
      });
    } catch (error) {
      sendResponse({ error: error.message });
    }
  })();

  return true;
});
