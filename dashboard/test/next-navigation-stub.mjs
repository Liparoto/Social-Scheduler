/**
 * Stub for `next/navigation` under the UI test harness, alongside react-link-stub.mjs.
 *
 * renderToStaticMarkup only renders — nothing navigates, refreshes or transitions — so the
 * router's methods are no-ops. Without this, any component calling useRouter() cannot be
 * UI-tested at all, which is why the components that had tests were the router-free ones.
 *
 * These deliberately do nothing rather than record calls: a static render never invokes
 * them, so an assertion on them would be testing the stub, not the component.
 */

const noopRouter = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
};

export function useRouter() {
  return noopRouter;
}

export function usePathname() {
  return "/";
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function useParams() {
  return {};
}

export function redirect() {}
export function notFound() {}
