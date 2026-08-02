/** Public Cartethyia landing page — deliberately independent from the authenticated console SPA. */

import type { HTTPHeaders } from "elysia";

const LANDING_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";

/** Renders the public, unauthenticated landing page. */
export function landingPage(set: { headers: HTTPHeaders }): string {
  set.headers["content-type"] = "text/html; charset=utf-8";
  set.headers["content-security-policy"] = LANDING_CSP;
  set.headers["referrer-policy"] = "strict-origin-when-cross-origin";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1726">
  <title>Cartethyia — The Kingdom's Gateway</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500;1,600&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --night: #081421;
      --deep: #0d2130;
      --ink: #eaf4f4;
      --muted: #a7bcc0;
      --mist: #d9ece7;
      --aqua: #92e0d3;
      --aqua-strong: #58c7bd;
      --gold: #e4c98f;
      --line: rgba(214, 239, 233, .2);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-snap-type: y proximity; scroll-padding-top: 18px; }
    body {
      margin: 0;
      background: var(--night);
      color: var(--ink);
      font-family: Manrope, system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; text-decoration: none; }
    a:focus-visible { outline: 2px solid var(--aqua); outline-offset: 4px; }
    .skip-link { position: absolute; left: 18px; top: 14px; z-index: 5; transform: translateY(-160%); padding: 10px 14px; border-radius: 8px; color: var(--night); background: var(--aqua); font-size: 11px; font-weight: 700; }
    .skip-link:focus-visible { transform: translateY(0); }
    .landing { position: relative; min-height: 100vh; overflow-x: clip; overflow-y: visible; isolation: isolate; background: transparent; }
    .landing-video { position: fixed; inset: 0; z-index: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; pointer-events: none; }
    .landing::before { content: ""; position: fixed; inset: 0; z-index: 1; pointer-events: none; background: linear-gradient(180deg, rgba(5,14,24,.2) 0%, rgba(5,14,24,.48) 100%); }
    .landing > *:not(.landing-video):not(.back-to-top) { position: relative; z-index: 2; }
    .welcome-screen { display: none; position: fixed; inset: 0; z-index: 20; place-items: center; align-content: center; gap: 13px; color: var(--mist); background: radial-gradient(circle at 50% 42%, rgba(35, 82, 91, .38), transparent 34%), var(--night); opacity: 0; transform: scale(1.03); transition: opacity .72s ease, transform .72s ease; }
    .js .welcome-screen { display: grid; }
    .welcome-screen.is-ready { opacity: 1; transform: scale(1); }
    .welcome-screen.is-leaving { opacity: 0; pointer-events: none; transform: scale(1.04); }
    .welcome-screen p { margin: 0; color: var(--gold); font-size: 10px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; }
    .welcome-screen strong { font: 600 clamp(46px, 8vw, 88px)/.95 Cinzel, serif; letter-spacing: .04em; }
    .welcome-screen strong small { display: block; margin-top: 10px; color: var(--aqua); font: 600 12px/1 Manrope, sans-serif; letter-spacing: .22em; }
    .hero h1 small { display: inline-block; margin-left: 10px; color: var(--aqua); font: 600 .18em/1 Manrope, sans-serif; letter-spacing: .12em; vertical-align: middle; }
    .welcome-screen span { color: var(--muted); font: italic 500 22px/1.1 'Cormorant Garamond', serif; }
    .welcome-suppress { display: inline-flex; align-items: center; gap: 8px; margin-top: 5px; color: rgba(217,236,231,.62); font-size: 10px; letter-spacing: .04em; cursor: pointer; }
    .welcome-suppress input { width: 13px; height: 13px; accent-color: var(--aqua); }
    .welcome-crest { display: grid; place-items: center; width: 76px; height: 76px; margin-bottom: 7px; border: 1px solid rgba(228,201,143,.5); border-radius: 50%; color: var(--gold); font: 500 42px/1 'Cormorant Garamond', serif; box-shadow: 0 0 0 10px rgba(228,201,143,.05), 0 0 56px rgba(146,224,211,.14); }
    .welcome-screen button { margin-top: 19px; border: 1px solid rgba(146,224,211,.6); border-radius: 999px; padding: 13px 21px; color: var(--night); background: var(--aqua); font: 700 10px Manrope, sans-serif; letter-spacing: .16em; text-transform: uppercase; cursor: pointer; }
    .welcome-screen button:hover { background: #b1eee1; }
    @keyframes welcome-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .welcome-screen.is-ready .welcome-crest { animation: welcome-rise .8s cubic-bezier(.2,.8,.2,1) both; }
    .welcome-screen.is-ready p { animation: welcome-rise .8s .1s cubic-bezier(.2,.8,.2,1) both; }
    .welcome-screen.is-ready strong { animation: welcome-rise .9s .18s cubic-bezier(.2,.8,.2,1) both; }
    .welcome-screen.is-ready span { animation: welcome-rise .8s .32s cubic-bezier(.2,.8,.2,1) both; }
    .welcome-screen.is-ready button { animation: welcome-rise .8s .44s cubic-bezier(.2,.8,.2,1) both; }
    .welcome-screen.is-ready .welcome-suppress { animation: welcome-rise .8s .52s cubic-bezier(.2,.8,.2,1) both; }
    .hero, .story, .features, .video-stage, .pricing { scroll-snap-align: start; }
    .hero {
      position: relative;
      min-height: min(860px, 100vh);
      display: flex;
      flex-direction: column;
      isolation: isolate;
      background: transparent;
    }
    .hero::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: linear-gradient(90deg, rgba(5,14,24,.6) 0%, rgba(5,14,24,.28) 42%, rgba(5,14,24,.04) 100%), linear-gradient(180deg, rgba(5,14,24,.04) 0%, rgba(5,14,24,.02) 44%, rgba(8,20,33,.78) 100%); }
    .hero::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: .18;
      z-index: -1;
      background-image: radial-gradient(rgba(255,255,255,.9) .65px, transparent .65px);
      background-size: 5px 5px;
      mix-blend-mode: soft-light;
    }
    .nav {
      width: min(1180px, calc(100% - 48px));
      margin: 0 auto;
      padding: 27px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      position: relative;
      z-index: 2;
    }
    .brand { display: inline-flex; align-items: center; gap: 13px; letter-spacing: .2em; font: 600 12px Cinzel, serif; }
    .crest { color: var(--gold); font: 500 27px 'Cormorant Garamond', serif; line-height: 1; transform: translateY(-1px); }
    .nav-links { display: flex; align-items: center; gap: 27px; color: var(--muted); font-size: 11px; letter-spacing: .16em; text-transform: uppercase; }
    .nav-links a:hover { color: var(--ink); }
    .community-link { color: var(--aqua) !important; }
    .mobile-community-link { display: none !important; }
    .nav-marquee { width: 100%; overflow: hidden; border-top: 1px solid rgba(214,239,233,.12); border-bottom: 1px solid rgba(214,239,233,.12); padding: 10px 0; background: rgba(8,20,33,.18); mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent); }
    .nav-marquee-track { display: flex; width: max-content; animation: nav-slide 23s linear infinite; }
    .nav-marquee-track span { display: inline-flex; align-items: center; gap: 12px; padding-right: 38px; white-space: nowrap; color: var(--aqua); font-size: 9px; letter-spacing: .18em; text-transform: uppercase; }
    .nav-marquee-track span::before { content: "✦"; color: var(--gold); }
    @keyframes nav-slide { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .nav-actions { display: flex; align-items: center; gap: 18px; }
    .console-link { border: 1px solid var(--line); border-radius: 999px; padding: 11px 18px; color: var(--mist); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; transition: background .2s, border-color .2s; }
    .console-link:hover { background: rgba(146,224,211,.12); border-color: rgba(146,224,211,.6); }
    .hero-content { width: min(1180px, calc(100% - 48px)); margin: auto; padding: 64px 0 106px; position: relative; z-index: 1; }
    .js .hero-content { opacity: 0; transform: translateY(18px); transition: opacity 1s ease .18s, transform 1s cubic-bezier(.2,.8,.2,1) .18s; }
    .js .hero-content.is-entered { opacity: 1; transform: translateY(0); }
    .eyebrow { display: flex; align-items: center; gap: 12px; color: var(--aqua); font-size: 10px; font-weight: 700; letter-spacing: .28em; text-transform: uppercase; }
    .eyebrow::before { content: ""; width: 37px; height: 1px; background: var(--aqua-strong); box-shadow: 0 0 14px var(--aqua-strong); }
    h1, h2, h3 { margin: 0; font-family: Cinzel, Georgia, serif; font-weight: 600; text-wrap: balance; }
    h1 { max-width: 640px; margin-top: 20px; color: #f1faf7; font-size: clamp(48px, 7vw, 98px); line-height: .92; letter-spacing: .035em; text-shadow: 0 6px 30px rgba(0,0,0,.28); }
    h1 span { display: block; color: var(--gold); font-size: .36em; line-height: 1.8; letter-spacing: .32em; text-indent: .32em; }
    .lede { max-width: 420px; margin: 26px 0 0; color: var(--mist); font: italic 500 clamp(19px, 2vw, 24px)/1.18 'Cormorant Garamond', Georgia, serif; }
    .hero-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 13px; margin-top: 35px; }
    .primary, .secondary { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 46px; border-radius: 999px; padding: 0 23px; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; transition: transform .2s, background .2s, border-color .2s; }
    .primary { color: #102129; background: var(--aqua); box-shadow: 0 10px 35px rgba(88,199,189,.22); }
    .primary:hover { transform: translateY(-2px); background: #b1eee1; }
    .secondary { border: 1px solid var(--line); color: var(--mist); }
    .secondary:hover { transform: translateY(-2px); border-color: rgba(228,201,143,.7); color: var(--gold); }
    .hero-mark { position: absolute; right: 2%; top: 43%; display: grid; place-items: center; width: 190px; height: 190px; border: 1px solid rgba(228,201,143,.43); border-radius: 50%; color: var(--gold); opacity: .8; transform: rotate(-12deg); }
    .hero-mark::before, .hero-mark::after { content: ""; position: absolute; border: 1px solid rgba(228,201,143,.3); border-radius: 50%; }
    .hero-mark::before { inset: 11px; }
    .hero-mark::after { inset: 21px; }
    .hero-mark strong { font: 500 74px/.8 'Cormorant Garamond', serif; }
    .hero-mark small { position: absolute; bottom: 31px; font: 600 8px Manrope, sans-serif; letter-spacing: .22em; }
    .scroll-cue { position: absolute; left: max(24px, calc((100% - 1180px) / 2)); bottom: 32px; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 9px; letter-spacing: .2em; text-transform: uppercase; }
    .scroll-cue i { display: block; width: 34px; height: 1px; background: var(--line); }
    .js .reveal { opacity: var(--reveal-opacity, 0); filter: blur(var(--reveal-blur, 7px)); transform: translateY(var(--reveal-y, 42px)) scale(var(--reveal-scale, .98)); transition: opacity .14s linear, filter .14s linear, transform .14s linear; will-change: opacity, filter, transform; }
    .js .reveal.is-visible { will-change: auto; }
    .features, .pricing, .video-stage { width: min(1180px, calc(100% - 48px)); margin: 0 auto; }
    .features { padding: 104px 0 126px; }
    .section-heading { max-width: 640px; }
    .section-heading h2 { margin-top: 17px; }
    .feature-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px; margin-top: 47px; }
    .feature-card { min-height: 240px; padding: 24px; border: 1px solid var(--line); background: linear-gradient(145deg, rgba(26,62,72,.55), rgba(8,20,33,.75)); box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
    .feature-card:nth-child(2) { transform: translateY(18px); }
    .feature-card:nth-child(3) { transform: translateY(7px); }
    .feature-number { color: var(--gold); font: 500 28px/1 'Cormorant Garamond', serif; }
    .feature-card h3 { margin-top: 54px; color: var(--mist); font-size: 18px; line-height: 1.08; }
    .feature-card p { margin: 13px 0 0; color: var(--muted); font: 500 18px/1.22 'Cormorant Garamond', serif; }
    .video-stage { padding: 10px 0 126px; }
    .video-layout { display: grid; grid-template-columns: .72fr 1.28fr; gap: clamp(38px, 8vw, 120px); align-items: center; }
    .video-copy p { max-width: 390px; margin: 24px 0 0; color: var(--muted); font: 500 21px/1.3 'Cormorant Garamond', serif; }
    .gallery { min-width: 0; }
    .gallery-viewport { position: relative; min-height: 430px; overflow: hidden; border: 1px solid var(--line); background: #0b1b28; }
    .gallery-slide { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: end; margin: 0; opacity: 0; pointer-events: none; transform: scale(1.025); transition: opacity .65s ease, transform .9s cubic-bezier(.2,.8,.2,1); }
    .gallery-slide.is-active { opacity: 1; pointer-events: auto; transform: scale(1); }
    .gallery-slide img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; }
    .gallery-slide::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8,20,33,.04) 36%, rgba(8,20,33,.94) 100%); }
    .gallery-caption { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 5px; padding: 26px; }
    .gallery-caption strong { color: var(--mist); font: 600 21px Cinzel, serif; }
    .gallery-caption span { color: var(--aqua); font-size: 10px; letter-spacing: .13em; text-transform: uppercase; }
    .gallery-controls { display: flex; align-items: center; justify-content: space-between; gap: 15px; margin-top: 14px; }
    .gallery-arrow { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--line); border-radius: 50%; color: var(--mist); background: transparent; cursor: pointer; transition: border-color .2s, color .2s, background .2s; }
    .gallery-arrow:hover { border-color: var(--aqua); color: var(--aqua); background: rgba(146,224,211,.1); }
    .gallery-dots { display: flex; align-items: center; gap: 7px; }
    .gallery-dot { width: 23px; height: 2px; border: 0; padding: 0; background: var(--line); cursor: pointer; transition: width .25s, background .25s; }
    .gallery-dot.is-active { width: 42px; background: var(--gold); }
    .pricing { padding: 6px 0 130px; }
    .pricing-layout { display: grid; grid-template-columns: 1fr .78fr; gap: clamp(38px, 10vw, 150px); align-items: end; }
    .pricing-copy p { max-width: 420px; margin: 23px 0 0; color: var(--muted); font: 500 21px/1.3 'Cormorant Garamond', serif; }
    .price-card { position: relative; padding: 32px; border: 1px solid rgba(146,224,211,.45); background: linear-gradient(150deg, rgba(28,77,84,.6), rgba(8,20,33,.82)); box-shadow: 0 20px 70px rgba(0,0,0,.22); }
    .price-card::before { content: "COMMUNITY ACCESS"; position: absolute; top: 17px; right: 20px; color: var(--aqua); font-size: 8px; font-weight: 700; letter-spacing: .2em; }
    .price-card h3 { color: var(--mist); font-size: 25px; }
    .price-amount { margin-top: 19px; color: var(--gold); font: 600 53px/.9 Cinzel, serif; }
    .price-amount small { color: var(--muted); font: 500 16px Manrope, sans-serif; letter-spacing: .06em; }
    .price-list { display: grid; gap: 11px; margin: 27px 0 28px; padding: 0; list-style: none; color: var(--mist); font-size: 12px; }
    .price-list li::before { content: "✦"; margin-right: 10px; color: var(--aqua); }
    .price-actions { display: flex; flex-wrap: wrap; gap: 11px; }
    .back-to-top { position: fixed; right: 24px; bottom: 24px; z-index: 8; display: grid; place-items: center; width: 43px; height: 43px; border: 1px solid rgba(146,224,211,.6); border-radius: 50%; color: var(--aqua); background: rgba(8,20,33,.76); backdrop-filter: blur(14px); opacity: 0; pointer-events: none; transform: translateY(12px); transition: opacity .25s, transform .25s, background .2s; cursor: pointer; }
    .back-to-top.is-visible { opacity: 1; pointer-events: auto; transform: translateY(0); }
    .back-to-top:hover { background: rgba(146,224,211,.14); }
    .story { width: min(1180px, calc(100% - 48px)); margin: 0 auto; padding: 112px 0 130px; display: grid; grid-template-columns: .82fr 1.18fr; gap: clamp(40px, 9vw, 150px); align-items: start; scroll-margin-top: 20px; }
    .section-kicker { color: var(--gold); font-size: 10px; font-weight: 700; letter-spacing: .22em; text-transform: uppercase; }
    h2 { margin-top: 17px; color: var(--mist); font-size: clamp(31px, 4vw, 54px); line-height: 1.06; }
    .story-copy { color: var(--muted); font: 500 22px/1.32 'Cormorant Garamond', Georgia, serif; }
    .story-copy p { margin: 0 0 22px; }
    .story-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 14px; margin-top: 43px; }
    .story-card { min-height: 205px; padding: 23px; display: flex; flex-direction: column; justify-content: end; border: 1px solid var(--line); background: linear-gradient(180deg, rgba(15,37,49,.2), rgba(15,37,49,.92)), var(--card-image) center/cover; }
    .story-card.tall { min-height: 286px; }
    .story-card small { color: var(--aqua); font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
    .story-card strong { margin-top: 7px; color: var(--mist); font: 600 22px/1.05 Cinzel, serif; }
    footer { border-top: 1px solid rgba(214,239,233,.12); padding: 26px max(24px, calc((100% - 1180px) / 2)); display: flex; justify-content: space-between; gap: 20px; color: var(--muted); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
    @media (max-width: 760px) {
      html { scroll-snap-type: none; }
      .nav, .hero-content, .story { width: min(100% - 36px, 590px); }
      .nav { padding-top: 20px; }
      .nav-links { display: none; }
      .nav-actions { gap: 0; }
      .nav-actions .community-link { display: none; }
      .mobile-community-link { display: inline-flex !important; }
      .hero-content { padding: 106px 0 150px; }
      .hero-mark { right: -50px; top: 13%; transform: scale(.72) rotate(-12deg); opacity: .55; }
      .landing-video { object-position: 58% center; }
      .story { grid-template-columns: 1fr; padding: 82px 0 90px; gap: 40px; }
      .story-grid { grid-template-columns: 1fr 1fr; }
      .story-card { min-height: 180px; padding: 17px; }
      .story-card.tall { min-height: 220px; }
      .features, .pricing, .video-stage { width: min(100% - 36px, 590px); }
      .features { padding: 72px 0 86px; }
      .feature-grid { grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 32px; }
      .feature-card { min-height: 190px; padding: 17px; }
      .feature-card:nth-child(2), .feature-card:nth-child(3) { transform: none; }
      .feature-card h3 { margin-top: 31px; font-size: 15px; }
      .feature-card p { margin-top: 9px; font-size: 16px; }
      .video-stage { padding-bottom: 87px; }
      .video-layout, .pricing-layout { grid-template-columns: 1fr; gap: 35px; }
      .gallery-viewport { min-height: 330px; }
      .pricing { padding-bottom: 90px; }
      .price-card { padding: 25px 21px; }
      .back-to-top { right: 17px; bottom: 17px; }
      footer { flex-direction: column; padding: 23px 18px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; scroll-snap-type: none; }
      .primary, .secondary, .console-link, .back-to-top, .welcome-screen { transition: none; }
      .js .reveal, .js .hero-content { opacity: 1; filter: none; transform: none; }
      .welcome-screen.is-ready .welcome-crest, .welcome-screen.is-ready p, .welcome-screen.is-ready strong, .welcome-screen.is-ready span, .welcome-screen.is-ready button, .welcome-screen.is-ready .welcome-suppress { animation: none; }
    }
  </style>
</head>
<body>
  <div class="welcome-screen" data-welcome role="dialog" aria-modal="true" aria-label="Welcome to Cartethyia">
    <div class="welcome-crest" aria-hidden="true">⚜</div>
    <p>By Cartethyia</p>
    <strong>Fleurdelys <small>芙露德莉斯</small></strong>
    <span>The Blessed Maiden · The gates are open.</span>
    <button type="button" data-welcome-enter>Enter the kingdom ↗</button>
    <label class="welcome-suppress"><input type="checkbox" data-welcome-suppress> Do not show again for 12 hours</label>
  </div>
  <a class="skip-link" href="#story">Skip to the realm</a>
  <main class="landing">
    <video class="landing-video" data-hero-video autoplay muted loop playsinline preload="metadata" poster="/landing-assets/cartethyia-profile-header.jpg" aria-hidden="true">
      <source src="/landing-assets/echoborn-cartethyia-awakens.1920x1080.mp4" type="video/mp4">
    </video>
    <section class="hero" id="top">
      <nav class="nav" aria-label="Main navigation">
        <a class="brand" href="#top"><span class="crest" aria-hidden="true">⚜</span><span>CARTETHYIA</span></a>
        <div class="nav-links"><a href="#features">Features</a><a href="#pricing">Community</a><a href="https://github.com/risuncode/cartethyia" target="_blank" rel="noreferrer">GitHub</a></div>
        <div class="nav-actions"><a class="community-link" href="https://discord.gg/zFcNPJM6qM" target="_blank" rel="noreferrer">Discord ↗</a><a class="console-link" href="/console/">Enter console ↗</a></div>
      </nav>
      <div class="nav-marquee" aria-label="Cartethyia status"><div class="nav-marquee-track"><span>The court is open · Community access is free</span><span>Route with intent · Keep the realm moving</span><span>Build your own kingdom · Community lives on Discord</span><span>The court is open · Community access is free</span><span>Route with intent · Keep the realm moving</span><span>Build your own kingdom · Community lives on Discord</span></div></div>
      <div class="hero-content">
        <div class="eyebrow">A sovereign gateway for your models</div>
        <h1><span>By Cartethyia</span>Fleurdelys <small>芙露德莉斯</small></h1>
        <p class="lede">Cartethyia, the Aero Congenital Resonator revered throughout Rinascita as Fleurdelys, the Blessed Maiden.</p>
        <div class="hero-actions"><a class="primary" href="/console/">Enter the kingdom <span aria-hidden="true">↗</span></a><a class="secondary" href="#features">Discover the house</a><a class="secondary mobile-community-link" href="https://discord.gg/zFcNPJM6qM" target="_blank" rel="noreferrer">Community Discord ↗</a></div>
      </div>
      <div class="hero-mark" aria-hidden="true"><strong>⚜</strong><small>GALE · TIDE · ORDER</small></div>
      <div class="scroll-cue"><i></i>Scroll to enter the realm</div>
    </section>
    <section class="story" id="story">
      <div class="reveal" data-reveal><div class="section-kicker">The house of Cartethyia</div><h2>Where every request finds its rightful path.</h2></div>
      <div class="story-copy reveal" data-reveal><p>Cartethyia (芙露德莉斯) is revered throughout Rinascita as Fleurdelys, the Blessed Maiden — and, in some accounts, the Martyred Maiden. Her story is bound to the Sentinel Imperator, the Threnodian Leviathan, and the Dark Tide.</p><p>Her true desire is simpler: to cast off the weight of her titles and live as a just, righteous wandering knight. “The crown of winds... has been engulfed by the sea. Tell me, are you the one who summoned this blade?”</p><div class="story-grid"><article class="story-card tall" style="--card-image: url('/landing-assets/fleurdelys-official.jpg')"><small>I · The frontier</small><strong>Bring your houses together.</strong></article><article class="story-card" style="--card-image: url('/landing-assets/cartethyia-official-sword.jpg')"><small>II · The court</small><strong>Route with intent.</strong></article></div></div>
    </section>
    <section class="features" id="features">
      <div class="section-heading reveal" data-reveal><div class="section-kicker">The royal infrastructure</div><h2>Every house, under one standard.</h2></div>
      <div class="feature-grid">
        <article class="feature-card reveal" data-reveal><div class="feature-number">01</div><h3>Route with intent.</h3><p>Priority, round-robin, aliases, and sticky routing for every model house.</p></article>
        <article class="feature-card reveal" data-reveal><div class="feature-number">02</div><h3>Keep the court moving.</h3><p>Rotate accounts, respect cooldowns, and let failover recover gracefully.</p></article>
        <article class="feature-card reveal" data-reveal><div class="feature-number">03</div><h3>Shape the response.</h3><p>Model Studio gives you history, compaction, token usage, and clean edits.</p></article>
        <article class="feature-card reveal" data-reveal><div class="feature-number">04</div><h3>See the whole realm.</h3><p>Usage, requests, logs, keys, and provider health in one quiet console.</p></article>
      </div>
    </section>
    <section class="video-stage">
      <div class="video-layout">
        <div class="video-copy reveal" data-reveal><div class="section-kicker">A moving portrait</div><h2>Let the wind arrive.</h2><p>A small gallery for the faces, forms, and quiet storms that shape the house. Every image keeps its credit below the frame.</p></div>
        <div class="gallery reveal" data-reveal data-gallery>
          <div class="gallery-viewport">
            <figure class="gallery-slide is-active" data-gallery-slide><img src="/landing-assets/fleurdelys-official.jpg" alt="Fleurdelys in her royal form"><figcaption class="gallery-caption"><strong>Fleurdelys</strong><span>Official character art · Kuro Games · <a href="https://x.com/Wuthering_Waves/status/1904714927438520656" target="_blank" rel="noreferrer">source ↗</a></span></figcaption></figure>
            <figure class="gallery-slide" data-gallery-slide><img src="/landing-assets/cartethyia-official-sword.jpg" alt="Cartethyia with her sword"><figcaption class="gallery-caption"><strong>This sword shall follow your will.</strong><span>Official artwork · Wuthering Waves X · <a href="https://x.com/Wuthering_Waves/status/1937360031579771242" target="_blank" rel="noreferrer">source ↗</a></span></figcaption></figure>
            <figure class="gallery-slide" data-gallery-slide><img src="/landing-assets/cartethyia-profile-header.jpg" alt="Cartethyia profile artwork"><figcaption class="gallery-caption"><strong>Queen of Gale &amp; Tide</strong><span>Profile artwork · Wuthering Waves Wiki · <a href="https://wutheringwaves.fandom.com/wiki/File:Cartethyia_Profile_Header.jpg" target="_blank" rel="noreferrer">source ↗</a></span></figcaption></figure>
          </div>
          <div class="gallery-controls"><button class="gallery-arrow" type="button" data-gallery-prev aria-label="Previous gallery image">←</button><div class="gallery-dots" role="tablist" aria-label="Gallery images"><button class="gallery-dot is-active" type="button" data-gallery-dot="0" aria-label="Show gallery image 1" aria-selected="true"></button><button class="gallery-dot" type="button" data-gallery-dot="1" aria-label="Show gallery image 2" aria-selected="false"></button><button class="gallery-dot" type="button" data-gallery-dot="2" aria-label="Show gallery image 3" aria-selected="false"></button></div><button class="gallery-arrow" type="button" data-gallery-next aria-label="Next gallery image">→</button></div>
        </div>
      </div>
    </section>
    <section class="pricing" id="pricing">
      <div class="pricing-layout">
        <div class="pricing-copy reveal" data-reveal><div class="section-kicker">The community court</div><h2>Start free. Grow when the realm grows.</h2><p>Cartethyia stays open to the community. Use the gateway, explore the houses, and bring your own provider accounts into the court.</p><p>Community lives on Discord — <strong>[Cartethyia Home]</strong></p></div>
        <article class="price-card reveal" data-reveal><h3>Community</h3><div class="price-amount">Free <small>forever</small></div><ul class="price-list"><li>Self-hosted model routing</li><li>Provider accounts and aliases</li><li>Model Studio with persistent history</li><li>Usage, logs, and console access</li></ul><div class="price-actions"><a class="primary" href="/console/">Enter the kingdom ↗</a><a class="secondary" href="https://discord.gg/zFcNPJM6qM" target="_blank" rel="noreferrer">Join Discord</a><a class="secondary" href="https://github.com/risuncode/cartethyia" target="_blank" rel="noreferrer">View on GitHub</a></div></article>
      </div>
    </section>
    <button class="back-to-top" type="button" data-back-to-top aria-label="Back to top">↑</button>
    <footer><span>© Cartethyia</span><span>Character art © Kuro Games</span><a href="https://discord.gg/zFcNPJM6qM" target="_blank" rel="noreferrer">Community ↗</a><a href="https://github.com/risuncode/cartethyia" target="_blank" rel="noreferrer">GitHub ↗</a><a href="https://x.com/Wuthering_Waves/status/1937360031579771242" target="_blank" rel="noreferrer">Visual source ↗</a><a href="/console/">Open console ↗</a></footer>
  </main>
  <script src="/landing-assets/landing.js?v=scroll-progress-3" defer></script>
</body>
</html>`;
}
