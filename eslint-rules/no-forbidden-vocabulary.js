/**
 * Custom ESLint rule: no-forbidden-vocabulary
 *
 * Enforces that user-facing strings (TS/TSX literals, JSX text nodes, i18n message JSON) do
 * NOT contain any of the legally-banned terms enumerated in IMPLEMENTATION_NOTES.md §1.PB4.
 *
 * QrSiparis is a digital order information system, NOT a payment / POS / fiscal device. Vocabulary
 * is strictly bound by Cyxares legal posture (Doc 01 §7.1 + IMPL_NOTES §1.PB4):
 *   - Forbidden: receipt/invoice/payment/tax/VAT/cash-register/etc. across TR/EN/AR/RU/DE
 *   - Allowed exception: 'cashier' as a DB role identifier (NOT user-facing); UI must render
 *     via i18n key `common.staff_cashier` -> "Kasa Personeli" (TR)
 *
 * @type {import('eslint').Rule.RuleModule}
 */

const FORBIDDEN_VOCABULARY = {
  tr: [
    'fiş',
    'fatura',
    'ödeme',
    'ödendi',
    'ödendiği',
    'ödendiyse',
    'tahsilat',
    'tahsil edilen',
    'tahsil edilecek',
    'vergi',
    'kdv',
    'mali belge',
    'ökc',
    'ödeme kaydedici cihaz',
    'ödeme kaydedici',
    'çek',
    'dekont',
    'pos sistemi',
    'kasiyer',
  ],
  en: [
    'receipt',
    'invoice',
    'bill payment',
    'pay now',
    'tax',
    'vat',
    'sales tax',
    'tax receipt',
    'fiscal device',
    'cash register',
  ],
  ar: ['فاتورة', 'إيصال', 'ضريبة', 'دفع'],
  ru: ['чек', 'счёт-фактура', 'налог', 'оплатить'],
  de: ['rechnung', 'quittung', 'mwst', 'mehrwertsteuer', 'steuer', 'bezahlen'],
};

/** Files where role-constant literals are allowed (e.g. `role: 'cashier'`). */
const ROLE_CONSTANT_ALLOWLIST = [
  /[\\/]src[\\/]db[\\/]schema\.ts$/,
  /[\\/]src[\\/]types[\\/].*\.ts$/,
  /\.types\.ts$/,
  /[\\/]eslint-rules[\\/]/,
];

/** Words that should be allowed when they appear inside DB role-constant context. */
const ROLE_CONSTANT_TERMS = new Set(['cashier']);

/** Build a single regex per locale array (case-insensitive, word-boundary safe). */
function buildLocaleRegexes() {
  /** @type {Array<{ locale: string, term: string, pattern: RegExp }>} */
  const out = [];
  for (const [locale, terms] of Object.entries(FORBIDDEN_VOCABULARY)) {
    for (const term of terms) {
      // Escape regex special chars in `term`. Use simple substring match (case-insensitive).
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out.push({
        locale,
        term,
        pattern: new RegExp(escaped, 'iu'),
      });
    }
  }
  return out;
}

const ALL_REGEXES = buildLocaleRegexes();

/** Returns matched {locale, term} for the first hit, or null. */
function firstMatch(text) {
  for (const entry of ALL_REGEXES) {
    if (entry.pattern.test(text)) {
      return entry;
    }
  }
  return null;
}

function isRoleConstantAllowed(filename) {
  return ROLE_CONSTANT_ALLOWLIST.some((re) => re.test(filename));
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prohibit legally-banned vocabulary (receipt/invoice/payment/tax/VAT/etc.) across all user-facing strings',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          excludeRoleConstants: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        '[forbidden-vocabulary] "{{term}}" ({{locale}}) is legally banned in QrSiparis user-facing strings. See IMPLEMENTATION_NOTES.md §1.PB4 for the allowlist (e.g. use t("common.staff_cashier") instead of "Kasiyer").',
    },
  },
  create(context) {
    const filename = context.filename || context.getFilename();
    const options = context.options[0] || {};
    const excludeRoleConstants = options.excludeRoleConstants !== false;
    const roleConstantsAllowed = excludeRoleConstants && isRoleConstantAllowed(filename);

    function check(node, raw) {
      if (typeof raw !== 'string' || raw.length === 0) return;
      const m = firstMatch(raw);
      if (!m) return;
      // Honor the role-constant exemption: bypass when the offending term is a
      // role identifier and the file is in the allowlist.
      if (roleConstantsAllowed && ROLE_CONSTANT_TERMS.has(m.term.toLowerCase())) return;
      context.report({
        node,
        messageId: 'forbidden',
        data: { term: m.term, locale: m.locale },
      });
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        if (node.value && typeof node.value.cooked === 'string') {
          check(node, node.value.cooked);
        }
      },
      JSXText(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
    };
  },
};

export default rule;
