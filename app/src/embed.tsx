/**
 * The embeddable build.
 *
 * MAKIAI.app is a mix of Python and JavaScript with one codebase feeding two
 * builds, so this target assumes nothing about the host: no framework, no
 * bundler, no router. It is one script tag and one element, which works
 * identically inside a Flask or Django template, a static page, or a JS app.
 *
 *   <div data-clearswap></div>
 *   <script src="/static/clearswap.js"></script>
 *
 * Everything renders inside a shadow root. That is not decoration — this widget
 * ships opinionated global styles for elements as common as `section` and
 * `button`, and letting those leak into a host page would wreck it. The shadow
 * boundary makes the isolation mutual: the host cannot restyle the trade panel
 * out from under the user either.
 */
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from './App'
import { setRouterApiKey } from './config'
// Vite inlines this as a string in library mode, so the whole widget ships as a
// single file rather than a script the host must remember to pair with a CSS link.
import styles from './styles.css?inline'

export type MountOptions = {
  /** Optional routing-API key, to lift the public rate limits. */
  routerApiKey?: string
}

const mounted = new WeakMap<Element, { root: Root; host: HTMLElement }>()

/**
 * The stylesheet targets `:root` for theme tokens and `body` for the page
 * ground, neither of which exists inside a shadow root. `:host` is the shadow
 * equivalent of both.
 */
function shadowStylesheet(): string {
  return `${styles.replace(/:root/g, ':host')}
:host {
  display: block;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}`
}

function resolve(target: string | Element): Element | null {
  return typeof target === 'string' ? document.querySelector(target) : target
}

/** Render the trading interface into `target`. Safe to call twice on the same element. */
export function mount(target: string | Element, options: MountOptions = {}): void {
  const element = resolve(target)
  if (!element) {
    console.warn(`[clearswap] No element matched ${String(target)}; nothing mounted.`)
    return
  }
  if (mounted.has(element)) return

  if (options.routerApiKey) setRouterApiKey(options.routerApiKey)

  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = shadowStylesheet()
  shadow.append(style)

  const host = document.createElement('div')
  shadow.append(host)

  const root = createRoot(host)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  mounted.set(element, { root, host })
}

/** Tear down a mounted instance, e.g. when a single-page host navigates away. */
export function unmount(target: string | Element): void {
  const element = resolve(target)
  if (!element) return

  const instance = mounted.get(element)
  if (!instance) return

  instance.root.unmount()
  instance.host.remove()
  mounted.delete(element)
}

/**
 * Auto-mount anything carrying `data-clearswap`, so a template can drop the
 * widget in without writing any JavaScript at all. An explicit `mount()` call
 * still works for hosts that render their page after load.
 */
function autoMount(): void {
  for (const element of document.querySelectorAll('[data-clearswap]')) {
    mount(element, { routerApiKey: element.getAttribute('data-router-api-key') ?? undefined })
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount, { once: true })
  } else {
    autoMount()
  }
}
