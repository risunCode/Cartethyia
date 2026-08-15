/* @jsxImportSource solid-js */

import { lazy } from "solid-js";
import { Navigate, Route, Router } from "@solidjs/router";

import { AppShell } from "./layout";
import { RouteError } from "./route-error";

export const CONSOLE_ROUTE_PATHS = {
  login: "/login",
  root: "/",
  overview: "/overview",
  usage: "/usage",
  providers: "/providers",
  providerDetail: "/providers/:id",
  settings: "/settings",
  notFound: "*404",
} as const;

const LoginPage = lazy(() => import("../features/login/page").then((module) => ({ default: module.LoginPage })));
const OverviewPage = lazy(() => import("../features/overview/page").then((module) => ({ default: module.OverviewPage })));
const UsagePage = lazy(() => import("../features/usage/page").then((module) => ({ default: module.UsagePage })));
const ProvidersPage = lazy(() => import("../features/providers/page").then((module) => ({ default: module.ProvidersPage })));
const ProviderDetailPage = lazy(() => import("../features/providers/detail").then((module) => ({ default: module.ProviderDetailPage })));
const SettingsPage = lazy(() => import("../features/settings/page").then((module) => ({ default: module.SettingsPage })));

export function ConsoleRouter() {
  return (
    <Router base="/console">
      <Route path={CONSOLE_ROUTE_PATHS.login} component={LoginPage} />
      <Route path={CONSOLE_ROUTE_PATHS.root} component={AppShell}>
        <Route path={CONSOLE_ROUTE_PATHS.root} component={() => <Navigate href={CONSOLE_ROUTE_PATHS.overview} />} />
        <Route path={CONSOLE_ROUTE_PATHS.overview} component={OverviewPage} />
        <Route path={CONSOLE_ROUTE_PATHS.usage} component={UsagePage} />
        <Route path={CONSOLE_ROUTE_PATHS.providers} component={ProvidersPage} />
        <Route path={CONSOLE_ROUTE_PATHS.providerDetail} component={ProviderDetailPage} />
        <Route path={CONSOLE_ROUTE_PATHS.settings} component={SettingsPage} />
        <Route path={CONSOLE_ROUTE_PATHS.notFound} component={RouteError} />
      </Route>
    </Router>
  );
}