# Dashboard Cleanup Requirements

## Introduction

Dashboard saat ini sudah memiliki baseline yang sehat (`157` tes lulus pada `19` file dan production build lulus), tetapi struktur sumber, route legacy, dan strategi tes mulai menyebar. Cleanup ini bertujuan merapikan nama dan batas fitur tanpa mengubah URL publik, kontrak API, atau perilaku operator.

Scope utama:

- menyatukan penamaan folder, file, simbol halaman, dan route metadata;
- mengurangi shim/re-export yang tidak perlu;
- memecah hotspot besar hanya ketika batas tanggung jawabnya jelas;
- meningkatkan tes pada kontrak navigasi, state async, form/mutation, dan aksesibilitas;
- menjaga compatibility route lama melalui redirect yang eksplisit sampai migrasi selesai.

Non-goals:

- tidak mengubah desain visual atau copy produk tanpa alasan teknis;
- tidak mengubah endpoint backend atau format payload API;
- tidak mengimplementasikan fitur `Automation` yang memang masih placeholder;
- tidak menghapus route alias lama sebelum callsite dan kebutuhan deployment diverifikasi.

## Requirements

### Requirement 1 — Canonical naming and feature boundaries

**User Story:** Sebagai maintainer, saya ingin satu nama kanonik untuk setiap fitur dan entrypoint agar rename berikutnya tidak membutuhkan shim berlapis.

#### Acceptance Criteria

1. WHEN sebuah halaman di-load dari router THEN source module, exported component, route metadata, dan test suite SHALL memakai istilah kanonik yang sama.
2. WHEN route legacy seperti `/customization` atau `/token-saver` masih dipertahankan THEN route tersebut SHALL hanya menjadi redirect eksplisit ke route kanonik dan SHALL memiliki tes regresi.
3. WHEN wrapper seperti `AdvancedPage` atau `CliToolsPage` tidak menambah perilaku THEN router SHALL mengimpor entrypoint kanonik langsung atau wrapper SHALL memiliki alasan arsitektural yang terdokumentasi.
4. WHEN file/simbol exported di-rename THEN seluruh references, dynamic imports, tests, dan string route terkait SHALL ikut diperbarui menggunakan symbol-aware tooling.

### Requirement 2 — Stable application shell and API boundaries

**User Story:** Sebagai maintainer, saya ingin shell aplikasi dan akses API memiliki batas yang jelas agar perubahan halaman tidak memicu regresi global.

#### Acceptance Criteria

1. WHEN cleanup memindahkan kode dari `AppShell`, `ModelStudioPage`, `ProviderDetailPage`, atau `ModelPicker` THEN perilaku navigasi, auth redirect, lazy-load recovery, sidebar state, dan accessibility SHALL tetap sama.
2. WHEN query atau mutation baru ditambahkan THEN endpoint, query key, invalidation, dan error handling SHALL mengikuti satu pola repository yang konsisten.
3. WHEN sebuah helper hanya memformat atau menormalisasi payload THEN helper tersebut SHALL dapat dites tanpa mount halaman penuh.
4. WHEN cleanup selesai THEN TypeScript strict mode SHALL tetap lulus tanpa unused symbol suppression.

### Requirement 3 — Behavioral test coverage

**User Story:** Sebagai maintainer, saya ingin tes melindungi kontrak yang benar-benar terlihat user/operator, bukan sekadar keberadaan elemen.

#### Acceptance Criteria

1. WHEN protected navigation menerima `401` atau `next` yang tidak aman THEN tes SHALL memverifikasi redirect dan sanitasi tujuan.
2. WHEN user mengubah form provider, model picker, alias/combo, quota, settings, atau database action THEN tes SHALL memverifikasi payload/mutation, success state, error state, dan invalidation yang relevan.
3. WHEN SSE atau async query mengalami open, error, reconnect, unmount, atau stale response THEN tes SHALL memverifikasi lifecycle dan cleanup listener/timer.
4. WHEN dialog, drawer, picker, atau destructive action dipakai dengan keyboard THEN tes SHALL memverifikasi nama accessible, Escape/Enter, disabled/busy state, dan urutan callback yang terlihat user.
5. WHEN test fixture API dipakai lebih dari satu suite THEN helper fixture SHALL menghindari mock fetch yang duplikatif dan tetap membuat skenario setiap suite terbaca.

### Requirement 4 — Legacy/debt cleanup with no silent behavior change

**User Story:** Sebagai maintainer, saya ingin debt yang aman dihapus tanpa menghilangkan compatibility atau menyembunyikan error.

#### Acceptance Criteria

1. WHEN code path lama tidak lagi memiliki caller setelah rename THEN code, alias, import, dan komentar obsolete SHALL dihapus.
2. WHEN behavior belum memiliki kepastian contract backend THEN cleanup SHALL menambah characterization test terlebih dahulu dan SHALL tidak menebak format baru.
3. WHEN CSS/build warning atau console warning ditemukan THEN warning SHALL ditelusuri ke sumbernya; cleanup SHALL tidak sekadar menyuppress warning.
4. WHEN fitur memang placeholder (`Automation`) THEN status placeholder SHALL dipertahankan dan tidak diperlakukan sebagai implementasi selesai.

### Requirement 5 — Verification and maintainable delivery

**User Story:** Sebagai reviewer, saya ingin setiap batch cleanup dapat direview dan diverifikasi secara terpisah.

#### Acceptance Criteria

1. WHEN satu batch rename/refactor selesai THEN `bun run test` dan `bun run build` SHALL lulus.
2. WHEN perubahan menyentuh route, auth, SSE, atau destructive mutation THEN SHALL ada tes targeted untuk failure path yang relevan.
3. WHEN production build selesai THEN tidak ada warning baru yang berasal dari perubahan cleanup; warning CSS yang sudah ada SHALL dicatat atau diperbaiki pada batch terpisah.
4. WHEN implementation plan selesai THEN setiap task SHALL menunjuk file/simbol target, acceptance criteria terkait, dan bukti verifikasi.
