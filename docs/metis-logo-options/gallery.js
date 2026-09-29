"use strict";

const numberLabel = (id) => String(id).padStart(2, "0");

(() => {
  const root = document.documentElement;
  const optionCards = [...document.querySelectorAll("[data-option]")];
  const byId = new Map(optionCards.map((card) => [Number(card.dataset.option), card]));
  const selectionButtons = [...document.querySelectorAll("[data-select]")];
  const output = document.querySelector("#selection-output");
  const clearButton = document.querySelector("#clear-selection");
  const copyButton = document.querySelector("#copy-selection");
  const status = document.querySelector("#status");
  const dialog = document.querySelector("#logo-dialog");
  const dialogImage = document.querySelector("#dialog-image");
  const dialogDownload = document.querySelector("#dialog-download");
  const copyDialog = document.querySelector("#copy-dialog");
  const copyText = document.querySelector("#copy-text");
  const storageKey = "metis-logo-shortlist-20260923";
  const selected = new Set();
  let currentLogo = 1;
  let lastZoomButton = null;
  let statusTimer;

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(stored)) {
      stored.forEach((id) => {
        if (byId.has(id)) selected.add(id);
      });
    }
  } catch {
    // Local files and private browsing can deny storage; in-memory selection works.
  }

  const orderedSelection = () => [...selected].toSorted((a, b) => a - b);

  function announce(message) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.classList.add("is-visible");
    statusTimer = setTimeout(() => status.classList.remove("is-visible"), 2600);
  }

  function updateSelection() {
    const ids = orderedSelection();
    selectionButtons.forEach((button) => {
      const isSelected = selected.has(Number(button.dataset.select));
      button.setAttribute("aria-pressed", String(isSelected));
      button.textContent = isSelected ? "已加入候选 ✓" : "加入候选";
    });
    output.textContent = ids.length ? ids.map(numberLabel).join(" · ") : "尚未选择";
    document.querySelector("#selection-title").textContent = ids.length
      ? "你的候选 · " + ids.length + " 个"
      : "你的候选";
    clearButton.disabled = ids.length === 0;
    copyButton.disabled = ids.length === 0;
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      // Selection remains usable for this open page.
    }
  }

  selectionButtons.forEach((button) => {
    const id = Number(button.dataset.select);
    button.setAttribute(
      "aria-label",
      "加入或移出候选：" + numberLabel(id) + " " + byId.get(id).dataset.name,
    );
    button.addEventListener("click", () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      updateSelection();
    });
  });

  clearButton.addEventListener("click", () => {
    selected.clear();
    updateSelection();
    selectionButtons[0].focus();
    announce("已清空候选");
  });

  copyButton.addEventListener("click", async () => {
    const text =
      "Metis Logo 候选：" +
      orderedSelection()
        .map((id) => numberLabel(id) + " " + byId.get(id).dataset.name)
        .join("、");
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      announce("已复制候选编号");
    } catch {
      copyText.value = text;
      copyDialog.showModal();
      copyText.focus();
      copyText.select();
    }
  });

  document.querySelector("#close-copy-dialog").addEventListener("click", () => copyDialog.close());
  copyDialog.addEventListener("close", () => copyButton.focus());

  document.querySelectorAll("[data-background-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      root.dataset.background = button.dataset.backgroundChoice;
      document.querySelectorAll("[data-background-choice]").forEach((choice) => {
        choice.setAttribute("aria-pressed", String(choice === button));
      });
    });
  });

  function renderDialog(id) {
    currentLogo = id;
    const card = byId.get(id);
    const image = card.querySelector(".logo-stage img");
    const download = card.querySelector(".download-link");
    document.querySelector("#dialog-number").textContent =
      numberLabel(id) + " / 10 · " + card.dataset.en;
    document.querySelector("#dialog-title").textContent = card.dataset.name;
    document.querySelector("#dialog-description").textContent =
      card.querySelector(".description").textContent;
    dialogImage.src = image.getAttribute("src");
    dialogImage.alt = image.alt;
    dialogDownload.href = download.getAttribute("href");
    dialogDownload.download = download.download;
  }

  document.querySelectorAll("[data-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      lastZoomButton = button;
      renderDialog(Number(button.dataset.zoom));
      dialog.showModal();
    });
  });
  document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => lastZoomButton?.focus());

  function navigateLogo(step) {
    renderDialog(((currentLogo - 1 + step + optionCards.length) % optionCards.length) + 1);
  }
  document.querySelector("#previous-logo").addEventListener("click", () => navigateLogo(-1));
  document.querySelector("#next-logo").addEventListener("click", () => navigateLogo(1));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      navigateLogo(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  updateSelection();
})();
