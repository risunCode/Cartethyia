const root = document.documentElement;
const welcome = document.querySelector("[data-welcome]");
const welcomeButton = document.querySelector("[data-welcome-enter]");
const welcomeSuppress = document.querySelector("[data-welcome-suppress]");
const backToTop = document.querySelector("[data-back-to-top]");
const heroContent = document.querySelector(".hero-content");
const heroVideo = document.querySelector("[data-hero-video]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const welcomeSuppressionKey = "cartethyia:welcome-suppressed-until";
const twelveHours = 12 * 60 * 60 * 1000;

root.classList.add("js");
if (reducedMotion && heroVideo instanceof HTMLVideoElement) heroVideo.pause();

function revealHero() {
  document.body.classList.add("kingdom-entered");
  heroContent?.classList.add("is-entered");
}

function closeWelcome() {
  if (!(welcome instanceof HTMLElement) || welcome.dataset.closed === "true") return;
  welcome.dataset.closed = "true";
  revealHero();
  if (welcomeSuppress instanceof HTMLInputElement && welcomeSuppress.checked) {
    window.localStorage.setItem(welcomeSuppressionKey, String(Date.now() + twelveHours));
  } else {
    window.localStorage.removeItem(welcomeSuppressionKey);
  }
  welcome.classList.add("is-leaving");
  window.setTimeout(() => welcome.remove(), reducedMotion ? 0 : 720);
}

if (welcome instanceof HTMLElement) {
  const suppressedUntil = Number(window.localStorage.getItem(welcomeSuppressionKey));
  if (Number.isFinite(suppressedUntil) && suppressedUntil > Date.now()) {
    welcome.remove();
    revealHero();
  } else {
    window.localStorage.removeItem(welcomeSuppressionKey);
    window.requestAnimationFrame(() => welcome.classList.add("is-ready"));
    welcomeButton?.addEventListener("click", closeWelcome);
  }
}

const revealItems = Array.from(document.querySelectorAll("[data-reveal]"));

function updateRevealProgress() {
  const revealStart = window.innerHeight * 0.92;
  const revealEnd = window.innerHeight * 0.32;
  const revealDistance = revealStart - revealEnd;
  revealItems.forEach((item) => {
    const progress = Math.max(0, Math.min(1, (revealStart - item.getBoundingClientRect().top) / revealDistance));
    item.style.setProperty("--reveal-opacity", progress.toFixed(3));
    item.style.setProperty("--reveal-y", `${((1 - progress) * 42).toFixed(1)}px`);
    item.style.setProperty("--reveal-scale", (0.98 + progress * 0.02).toFixed(3));
    item.style.setProperty("--reveal-blur", `${((1 - progress) * 7).toFixed(1)}px`);
    item.classList.toggle("is-visible", progress >= 0.98);
  });
}

if (reducedMotion) {
  revealItems.forEach((item) => {
    item.style.setProperty("--reveal-opacity", "1");
    item.style.setProperty("--reveal-y", "0px");
    item.style.setProperty("--reveal-scale", "1");
    item.style.setProperty("--reveal-blur", "0px");
    item.classList.add("is-visible");
  });
} else {
  updateRevealProgress();
  window.addEventListener("scroll", updateRevealProgress, { passive: true });
  document.addEventListener("scroll", updateRevealProgress, { passive: true });
  window.addEventListener("resize", updateRevealProgress, { passive: true });
}

function updateBackToTop() {
  backToTop?.classList.toggle("is-visible", window.scrollY > 520);
}

window.addEventListener("scroll", updateBackToTop, { passive: true });
backToTop?.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
});
updateBackToTop();

const gallery = document.querySelector("[data-gallery]");
const gallerySlides = gallery ? Array.from(gallery.querySelectorAll("[data-gallery-slide]")) : [];
const galleryDots = gallery ? Array.from(gallery.querySelectorAll("[data-gallery-dot]")) : [];
const galleryPrevious = gallery?.querySelector("[data-gallery-prev]");
const galleryNext = gallery?.querySelector("[data-gallery-next]");
let activeGallerySlide = 0;

function setGallerySlide(nextIndex) {
  if (gallerySlides.length === 0) return;
  activeGallerySlide = (nextIndex + gallerySlides.length) % gallerySlides.length;
  gallerySlides.forEach((slide, index) => slide.classList.toggle("is-active", index === activeGallerySlide));
  galleryDots.forEach((dot, index) => {
    const isActive = index === activeGallerySlide;
    dot.classList.toggle("is-active", isActive);
    dot.setAttribute("aria-selected", String(isActive));
  });
}

galleryPrevious?.addEventListener("click", () => setGallerySlide(activeGallerySlide - 1));
galleryNext?.addEventListener("click", () => setGallerySlide(activeGallerySlide + 1));
galleryDots.forEach((dot, index) => dot.addEventListener("click", () => setGallerySlide(index)));
if (gallerySlides.length > 1 && !reducedMotion) {
  window.setInterval(() => setGallerySlide(activeGallerySlide + 1), 6200);
}
