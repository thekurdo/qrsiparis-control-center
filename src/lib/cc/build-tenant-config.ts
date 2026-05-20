/**
 * buildConfigSnapshot — pure transform from wizard form-state to the
 * canonical `RestaurantConfig` shape that customer-app's Zod schema
 * validates against at boot.
 *
 * Why this exists:
 *   The wizard collects data in step-bucketed form state (`{step1, step2,
 *   ...}`). Earlier the route just persisted that blob to
 *   `tenants.config_snapshot` and the deploy step rendered it to
 *   `restaurant.config.json`. Customer-app then crashed on boot because
 *   the top-level keys it expects are `restaurant, branding, locale,
 *   modules, operationalHours, limits, classic, singleflow, visual,
 *   quickorder, minimal, metadata` — NOT `step1..step6`.
 *
 *   This module is the canonical bridge. The scripts/onboard-tenant.ts
 *   CLI produces the same shape via its own `buildConfig()` helper; we
 *   keep them in lockstep until a shared schema package lands in V1.5.
 *
 * Reference values (defaults for the template-specific blocks, hours,
 * limits) come from `C:\Users\robar\sushi-config.json` — the snapshot
 * SUSHİ WİND ships to ghcr.io with. Only the matching template block
 * is consumed at runtime, but all five must be present for the schema
 * to validate.
 */

import type {
  Step1Data,
  Step2Data,
  Step3Data,
  Step4Data,
  WizardState,
} from '@/components/wizard/TenantWizardClient';
import type { Step5Data } from '@/components/wizard/Step5Modules';

// ---------------------------------------------------------------------------
// Canonical config shape — matches the customer-app Zod schema. Kept loose
// (`Record<string, unknown>` for the template blocks) because we don't have
// a shared package yet; runtime validation lives in the customer-app and
// we mirror the literal defaults below.
// ---------------------------------------------------------------------------

export interface RestaurantConfig {
  restaurant: {
    shortCode: string;
    name: string;
    domain: string;
    city: string;
    address: string;
    phone: string;
    email: string;
  };
  branding: {
    primaryColor: string;
    primaryColorForeground: string;
    template: string;
    font: string;
    theme: 'auto' | 'light' | 'dark';
    logoUrl?: string;
  };
  locale: {
    default: string;
    enabled: string[];
    currency: string;
    timezone: string;
    dateFormat: string;
    timeFormat: '24h' | '12h';
  };
  modules: {
    customerPwa: boolean;
    cashier: boolean;
    kitchen: boolean;
    waiter: boolean;
    admin: boolean;
    i18n: boolean;
    sms: boolean;
    printer: boolean;
    kioskMode: boolean;
  };
  operationalHours: Record<string, unknown>;
  limits: {
    maxTables: number;
    maxStaff: number;
    maxProducts: number;
    maxCategories: number;
    maxStorageMb: number;
    ordersPerMinute: number;
    apiRequestsPerMinute: number;
  };
  classic: Record<string, unknown>;
  singleflow: Record<string, unknown>;
  visual: Record<string, unknown>;
  quickorder: Record<string, unknown>;
  minimal: Record<string, unknown>;
  metadata: {
    configVersion: number;
    generatedAt: string;
    generatedBy: string;
    schemaVersion: number;
    tier: 'baslangic' | 'standart' | 'profesyonel';
  };
}

// ---------------------------------------------------------------------------
// Static defaults — always-open hours and the five template blocks.
// ---------------------------------------------------------------------------

function defaultOperationalHours(): Record<string, unknown> {
  const out: Record<string, { isOpen: boolean; openTime: string; closeTime: string }> = {};
  for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
    out[d] = { isOpen: true, openTime: '00:00', closeTime: '23:59' };
  }
  return { ...out, holidays: [] };
}

const TEMPLATE_DEFAULTS = {
  classic: {
    showProductImages: true,
    cardDensity: 'comfortable',
    showPreparationTime: true,
    categoryStyle: 'tabs',
    productImageStyle: 'rounded',
    emphasizeBrandColor: 'moderate',
  },
  singleflow: {
    showProductImages: true,
    defaultExpandBehavior: 'none',
    showCategoryEmoji: true,
    cardImageSize: 'md',
    showFirstAddToast: true,
  },
  visual: {
    showHeroSection: true,
    heroStyle: 'minimal',
    imageAspectRatio: '4:3',
    ornamentSymbol: '◆',
    displayFontFamily: 'playfair',
    showCategoryIndicator: true,
    enableScrollAnimations: true,
    imageQuality: 'high',
  },
  quickorder: {
    showProductImages: false,
    cardTapBehavior: 'add',
    categoryStyle: 'filter',
    alwaysShowCheckoutBar: false,
    enableLongPressDetail: true,
    mobilePortraitColumns: 2,
    mobileLandscapeColumns: 3,
    tabletColumns: 3,
    desktopColumns: 4,
  },
  minimal: {
    imageVariant: 'none',
    dividerStyle: 'dash',
    contentMaxWidth: 'narrow',
    showRestaurantName: true,
    fontStyle: 'sans',
    productNameWeight: 'regular',
  },
} as const;

const DEFAULT_LIMITS = {
  baslangic: { maxTables: 20, maxStaff: 5, maxProducts: 100, maxCategories: 10, maxStorageMb: 500, ordersPerMinute: 15, apiRequestsPerMinute: 100 },
  standart: { maxTables: 50, maxStaff: 10, maxProducts: 500, maxCategories: 30, maxStorageMb: 2000, ordersPerMinute: 25, apiRequestsPerMinute: 200 },
  profesyonel: { maxTables: 200, maxStaff: 30, maxProducts: 2000, maxCategories: 100, maxStorageMb: 10000, ordersPerMinute: 60, apiRequestsPerMinute: 600 },
} as const;

// Map the wizard-side font label (e.g. "Inter", "Playfair Display") into
// the lowercase token the customer-app expects. Anything not recognised is
// passed through as a lowercase slug.
function normalizeFont(label: string | undefined): string {
  if (!label) return 'inter';
  const v = label.trim().toLowerCase();
  if (v === 'playfair display') return 'playfair';
  if (v === 'custom') return 'inter'; // custom font URL is handled separately
  return v.replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// Main transform — pure function, no I/O.
// ---------------------------------------------------------------------------

export interface BuildConfigInput {
  step1: Step1Data;
  step2: Pick<Step2Data, 'tier'>;
  step3: Step3Data;
  step4: Step4Data;
  step5?: Step5Data;
}

export function buildConfigSnapshot(state: WizardState): RestaurantConfig {
  if (!state.step1 || !state.step2 || !state.step3 || !state.step4) {
    throw new Error('buildConfigSnapshot: missing required wizard steps (1–4)');
  }
  const s1 = state.step1;
  const s2 = state.step2;
  const s3 = state.step3;
  const s4 = state.step4;
  const s5 = state.step5;

  const tier = s2.tier;
  const limits = s5?.limits ?? DEFAULT_LIMITS[tier];

  const modules = s5?.modules
    ? {
        customerPwa: s5.modules.customerPwa,
        cashier: s5.modules.cashier,
        kitchen: s5.modules.kitchen,
        waiter: s5.modules.waiter,
        admin: s5.modules.admin,
        // Step5 omits i18n (treated as derived from locale count); enable
        // whenever more than one locale is active.
        i18n: (s5.locale?.enabled?.length ?? 1) > 1,
        sms: s5.modules.sms,
        printer: s5.modules.printer,
        kioskMode: s5.modules.kioskMode,
      }
    : {
        customerPwa: true,
        cashier: true,
        kitchen: true,
        waiter: true,
        admin: true,
        i18n: true,
        sms: false,
        printer: false,
        kioskMode: false,
      };

  const localeDefault = s5?.locale?.default ?? 'tr';
  const localeEnabled = s5?.locale?.enabled?.length
    ? s5.locale.enabled
    : ['tr', 'en'];

  const branding: RestaurantConfig['branding'] = {
    primaryColor: s4.primaryColor,
    primaryColorForeground: '#FFFFFF',
    template: s4.template,
    font: normalizeFont(s4.font),
    theme: 'auto',
  };
  if (s4.logoUrl) {
    branding.logoUrl = s4.logoUrl;
  }

  return {
    restaurant: {
      shortCode: s1.shortCode,
      name: s1.restaurantName,
      domain: s3.domain,
      city: s1.city,
      address: s1.address ?? '',
      phone: s1.phone,
      email: s1.email && s1.email.length > 0 ? s1.email : `${s1.shortCode}@gewdai.com`,
    },
    branding,
    locale: {
      default: localeDefault,
      enabled: localeEnabled,
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      dateFormat: 'DD.MM.YYYY',
      timeFormat: '24h',
    },
    modules,
    operationalHours: defaultOperationalHours(),
    limits,
    classic: { ...TEMPLATE_DEFAULTS.classic },
    singleflow: { ...TEMPLATE_DEFAULTS.singleflow },
    visual: { ...TEMPLATE_DEFAULTS.visual },
    quickorder: { ...TEMPLATE_DEFAULTS.quickorder },
    minimal: { ...TEMPLATE_DEFAULTS.minimal },
    metadata: {
      configVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: 'control-center',
      schemaVersion: 1,
      tier,
    },
  };
}
