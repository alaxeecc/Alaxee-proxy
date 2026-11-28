// Alaxee 曦 · Tailwind 预设（颜色都指向 CSS 变量，所以换 data-ax-theme 时一起变）。
// 先引入 tokens/tokens.css（或 ui/alaxee-ui.css），然后在 tailwind.config.js 里：presets: [require('./alaxee-kit/tokens/tailwind.preset.js')]
// 用法：bg-ax-surface text-ax-ink border-ax-line rounded-ax-lg bg-ax-dawn shadow-ax-md animate-ax-breathe
module.exports = {
  "theme": {
    "extend": {
      "colors": {
        "ax": {
          "bg": "var(--ax-bg)",
          "bg-2": "var(--ax-bg-2)",
          "surface": "var(--ax-surface)",
          "surface-2": "var(--ax-surface-2)",
          "sunken": "var(--ax-sunken)",
          "ink": "var(--ax-ink)",
          "muted": "var(--ax-muted)",
          "faint": "var(--ax-faint)",
          "line": "var(--ax-line)",
          "line-strong": "var(--ax-line-strong)",
          "accent": "var(--ax-accent)",
          "accent-hover": "var(--ax-accent-hover)",
          "accent-soft": "var(--ax-accent-soft)",
          "on-accent": "var(--ax-on-accent)",
          "focus": "var(--ax-focus)",
          "glow": "var(--ax-glow)",
          "sakura": "#E880BE",
          "rose": "#D9659C",
          "peach": "#FFA894",
          "gold": "#FFD9A8",
          "violet": "#6E5CD2",
          "night": "#181C5E",
          "moon": "#F6F4FF",
          "plum": "#4A3340",
          "success": "#3FB8A0",
          "warning": "#E8955A",
          "danger": "#E0577A",
          "info": "#6E8FE8"
        }
      },
      "borderRadius": {
        "ax-sm": "var(--ax-r-sm)",
        "ax-md": "var(--ax-r-md)",
        "ax-lg": "var(--ax-r-lg)",
        "ax-xl": "var(--ax-r-xl)",
        "ax-pill": "var(--ax-r-pill)",
        "ax-icon": "var(--ax-r-icon)"
      },
      "fontFamily": {
        "ax": [
          "var(--ax-font)"
        ],
        "ax-serif": [
          "var(--ax-serif)"
        ],
        "ax-mono": [
          "var(--ax-mono)"
        ]
      },
      "backgroundImage": {
        "ax-dawn": "var(--ax-grad-dawn)",
        "ax-cta": "var(--ax-grad-cta)",
        "ax-sky": "var(--ax-grad-sky)",
        "ax-bar": "var(--ax-grad-bar)"
      },
      "boxShadow": {
        "ax-sm": "var(--ax-shadow-sm)",
        "ax-md": "var(--ax-shadow-md)",
        "ax-lg": "var(--ax-shadow-lg)"
      },
      "transitionTimingFunction": {
        "ax": "var(--ax-ui-ease)",
        "ax-breath": "var(--ax-breath-ease)",
        "ax-spring": "var(--ax-spring)"
      },
      "transitionDuration": {
        "ax": "200ms",
        "ax-page": "360ms"
      },
      "keyframes": {
        "ax-breathe": {
          "0%, 100%": {
            "transform": "scale(.84)"
          },
          "50%": {
            "transform": "scale(1.26)"
          }
        }
      },
      "animation": {
        "ax-breathe": "ax-breathe 3.6s cubic-bezier(.4, 0, .6, 1) infinite"
      }
    }
  }
};
