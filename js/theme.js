(() => {
  let saved;
  try {
    saved = localStorage.getItem("ju-theme");
  } catch {}
  const requested = new URLSearchParams(location.search).get("theme");
  document.documentElement.dataset.theme =
    requested === "night"
      ? "dark"
      : requested === "day"
        ? "light"
        : ["light", "dark"].includes(saved)
          ? saved
          : matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
})();
