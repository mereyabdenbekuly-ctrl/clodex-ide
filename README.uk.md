<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/clodex/clodex-agentic-ide/refs/heads/main/logo-combo-dark.svg">
  <img src="https://raw.githubusercontent.com/clodex/clodex-agentic-ide/refs/heads/main/logo-combo.svg" alt="Clodex" height="60" />
</picture>

### Агентна IDE для open-source моделей

[English](./README.md) | [简体中文](./README.zh-CN.md) | [Deutsch](./README.de.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [हिन्दी](./README.hi.md) | [Русский](./README.ru.md) | Українська

 ![NPM License](https://img.shields.io/npm/l/clodex) [![GitHub Repo stars](https://img.shields.io/github/stars/clodex/clodex-agentic-ide)](https://github.com/clodex/clodex-agentic-ide)

[![Приєднатися до Discord](https://img.shields.io/discord/1229378372141056010?label=Discord&logo=discord&logoColor=white)](https://discord.gg/c9uGs3cFXr) [![Підписатися на X (колишній Twitter)](https://img.shields.io/twitter/follow/clodex_xyz)](https://x.com/clodex_xyz)

![Clodex Agentic IDE демо](https://raw.githubusercontent.com/clodex/clodex-agentic-ide/main/apps/website/src/app/(home)/_components/feature-images/full-demo-dark.png)

## Про проєкт

**Clodex Agentic IDE** — це агентна IDE з відкритим кодом для розробників зі вбудованим агентом-програмістом.

- **Переглядайте та розробляйте** в одному інструменті — без перемикання контексту
- **Працюйте з агентом-програмістом**, який має **повний доступ до консолі та дебагера вашої вкладки**
- **Вносіть тимчасові тестові зміни** або **підключайте кодову базу** для постійного редагування
- **Реверс-інжиніринг** компонентів, систем стилів та кольорових паліт будь-якого вебсайту
- **Інтеграція з IDE** для перегляду та застосування змін коду у вашому улюбленому редакторі
- **Використовуйте свій API-ключ (BYOK)** — повна підтримка всіх провайдерів ШІ

## Початок роботи

Завантажте Clodex Agentic IDE з [clodex.xyz](https://clodex.xyz) і дотримуйтесь короткого посібника для налаштування акаунта.

## Використовуйте свою підписку для програмування

Використовуйте свій ключ для всіх популярних провайдерів моделей — ви також можете реєструвати повністю кастомні провайдери (включно з локальним інференсом!) та визначати власні моделі.

### Швидкий імпорт — використовуйте наявну підписку

Підключіть будь-яку з наведених нижче підписок за допомогою одного API-ключа, щоб розблокувати всі моделі, що пропонує провайдер, безпосередньо в Clodex Agentic IDE.

| **Підписка** | **Провайдер** | **Рекомендовані моделі** | **Панель керування** |
| ------------ | ------------- | ----------------------- | ------------------- |
| Kimi | [Moonshot AI](https://platform.moonshot.ai) | Kimi K2.7 Code, Kimi K2.6, Kimi K2.5 | [Отримати API-ключ](https://platform.moonshot.ai/console/api-keys) |
| Qwen Coding Plan | [Alibaba DashScope](https://dashscope.console.aliyun.com) | Qwen 3-Coder 30B-A3B, Qwen 3-32B | [Отримати API-ключ](https://dashscope.console.aliyun.com/apiKey) |
| MiniMax | [MiniMax](https://platform.minimax.io) | MiniMax M3, MiniMax M2.7 | [Отримати API-ключ](https://platform.minimax.io/user-center/basic-information/interface-key) |
| Xiaomi MiMo | [Xiaomi MiMo](https://platform.xiaomimimo.com) | MiMo-V2.5-Pro, MiMo-V2.5 | [Отримати API-ключ](https://platform.xiaomimimo.com/#/console/plan-manage) |

### Акаунт Clodex Agentic IDE

Для зручного використання та негайного доступу до великої бібліотеки моделей просто створіть акаунт Clodex Agentic IDE.

| **План** | **Ціна**       | **Ліміти**                              |
| -------- | -------------- | --------------------------------------- |
| Free     | $0 / місяць    | Обмежений доступ до 3 стандартних моделей (Default, Quick, Smart) |
| Pro      | $20 / місяць   | Доступ до всіх моделей, включаючи Frontier та Open-Weights |
| Ultra    | $200 / місяць  | Доступ до всіх моделей, ліміти у 15x вищі ніж у Pro |

Включені моделі:

#### Моделі з відкритими вагами

- **Moonshot AI**: Kimi K2.7 Code, Kimi K2.6, Kimi K2.5
- **Alibaba**: Qwen 3-32B, Qwen 3-Coder 30B-A3B
- **DeepSeek**: DeepSeek V4 Pro, DeepSeek V4 Flash
- **Z.ai**: GLM 5.2, GLM 5.1, GLM 5V-Turbo
- **MiniMax**: MiniMax M3, MiniMax M2.7, MiniMax M2
- **Xiaomi MiMo**: MiMo-V2.5-Pro, MiMo-V2.5

#### Пропрієтарні моделі

- **Anthropic**: Fable 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Sonnet 4.6, Haiku 4.5
- **OpenAI**: GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5.3 Instant, GPT-5.4 mini, GPT-5.4 nano
- **Google**: Gemini 3.5 Flash, Gemini 3.1 Pro (Preview), Gemini 3 Flash, Gemini 3.1 Flash Lite

## Ліцензія

Clodex Agentic IDE розробляється Clodex Labs і пропонується за ліцензією AGPLv3.

Додаткову інформацію про модель ліцензування можна знайти в [FAQ щодо ліцензій GNU](https://www.gnu.org/licenses/gpl-faq.html).

Для сценаріїв використання, що виходять за межі дозволеного ліцензією AGPLv3, звертайтеся до нас за [електронною поштою](mailto:sales@clodex.xyz).

## Проблеми

Не соромтеся [відкрити issue](https://github.com/clodex/clodex-agentic-ide/issues/new), якщо ви знайшли баг або маєте свіжу ідею.

## Спільнота та підтримка

- [Приєднуйтесь до нашого Discord](https://discord.gg/c9uGs3cFXr)
- Відкрийте [issue на GitHub](https://github.com/clodex/clodex-agentic-ide/issues/new) для технічної підтримки.
