// The entry point of the page: the M3 styles and theme, then the app.
// The M3 styles and theme are imported by theme.css: m3-svelte exports them under the "style" condition,
// which Vite applies to CSS @import.
import "./theme.css";
import { mount } from "svelte";
import App from "./components/App.svelte";

const target = document.getElementById("app");
if (target !== null) mount(App, { target });
