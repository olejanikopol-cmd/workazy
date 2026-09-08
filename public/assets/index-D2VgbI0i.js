// Совместимость с HTML предыдущей публикации, который мог остаться в Safari.
const url = new URL(window.location.href);
if (url.searchParams.get("workazy-version") !== "41") {
  url.searchParams.set("workazy-version", "41");
  window.location.replace(url.toString());
}
