# Documentation

`@bachi/pi-coder` is a Pi package: extensions and themes are loaded from the package itself, while a handful of global config files are applied by hand.

| Document | Read it when |
| --- | --- |
| [installation.md](installation.md) | Installing, trying without installing, verifying that pi loaded everything, upgrading, uninstalling. |
| [configuration.md](configuration.md) | Applying `config/` files, and understanding what was intentionally left out of this package. |
| [extensions.md](extensions.md) | You want to know what an extension does, which command drives it, which environment switch silences it, or where it stores state. |
| [themes.md](themes.md) | Switching themes, editing them, or porting one. |
| [development.md](development.md) | Running the tests, adding an extension, verifying changes against a real pi, publishing. |
| [handbook.zh.md](handbook.zh.md) | **Chinese.** The original handbook this package was extracted from: the author's machine, the LiteLLM gateway, and the full rationale behind every design decision. It is more detailed than the English docs and is kept verbatim, including the parts that describe a machine you do not have. |

Everything else lives in the source: each extension carries a long header comment (in Chinese, except `rewind/`) explaining the pi internals it depends on, the failure that motivated it, and the trade-offs that are not obvious from the code.
