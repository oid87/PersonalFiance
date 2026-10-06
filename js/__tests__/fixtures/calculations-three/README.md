# Legacy calculation oracle sources

These are byte-for-byte copies of the pre-refactor tab files from
`Financial_work/artifacts/refactor_delivery_2026_10_02/before/PersonalFiance/js/tabs/`.
They are test fixtures only. Production code does not import them. Keeping the
sources here makes the oracle tests runnable in an independent PersonalFiance
checkout and in CI without the neighboring research repository.

| Fixture | SHA-256 |
| --- | --- |
| `trend.js` | `5b1e3e1b848b80774157ce46d0eaa0f5131cb8f81e0004703064bef0964b44dc` |
| `cpi.js` | `114506df0b04afb29bb43faba32e84b8a85899ba95a23ccf708688c0bf181ddb` |
| `vixskew.js` | `0d76bb2229ebf6ed8a1f9769891cccba5d3b12a4ecc897c00a991245207a4058` |

The tests read selected function text into Node's `vm` only for the legacy
oracle. They do not import or execute the complete browser tab modules.
