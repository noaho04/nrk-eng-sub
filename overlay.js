
const LoadingOverlay = (() => {
  let element = null;
  let status = null;

  function show(message) {
    if (element) {
      update(message);
      return;
    }

    element = document.createElement("div");
    element.id = "nrk-translation-overlay";

    element.innerHTML = `
      <div class="nrk-loader"></div>
      <div class="nrk-overlay-title">NRK English Subtitles</div>
      <div class="nrk-overlay-status"></div>
    `;

    const style = document.createElement("style");
    style.id = "nrk-overlay-styles";
    style.textContent = `
      #nrk-translation-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(10, 10, 10, 0.85);
        backdrop-filter: blur(8px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        color: white;
        font-family: system-ui, sans-serif;
      }

      .nrk-loader {
        width: 36px;
        height: 36px;
        border: 3px solid rgba(255,255,255,0.15);
        border-top-color: white;
        border-radius: 50%;
        animation: nrk-spin 0.8s linear infinite;
      }

      .nrk-overlay-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        opacity: 0.5;
      }

      .nrk-overlay-status {
        font-size: 15px;
        font-weight: 500;
        text-align: center;
      }

      @keyframes nrk-spin {
        to { transform: rotate(360deg); }
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(element);

    status = element.querySelector(".nrk-overlay-status");
    update(message);
  }

  function update(message) {
    if (status) status.textContent = message;
  }

  function hide() {
    element?.remove();
    element = null;
    status = null;

    document.getElementById("nrk-overlay-styles")?.remove();
  }

  return { show, update, hide };
})();
