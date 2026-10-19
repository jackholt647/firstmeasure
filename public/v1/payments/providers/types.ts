/**
 * Provider-agnostic payment processing contracts.
 *
 * These interfaces describe the acquiring-side capabilities the payments
 * module needs from a processor (create/capture/cancel intents, charges,
 * refunds, payouts, disputes, vaulted payment methods) plus the merchant
 * boarding lifecycle (business -> application -> account). All monetary
 * amounts are integer cents. Shapes intentionally stay close to Forward's
 * documented API (docs.getfwd.com) without leaking provider naming into the
 * callers — a future processor implements the same interfaces.
 */

export type JsonObject = Record<string, unknown>;

// --- Money movement ---------------------------------------------------------

export type ProviderPaymentIntentStatus =
  | "created"
  | "processing"
  | "pending"
  | "uncaptured"
  | "captured"
  | "cancelled"
  | "failed";

export type ProviderPaymentStatus =
  | "pending"
  | "processing"
  | "authorized"
  | "captured"
  | "settled"
  | "failed"
  | "cancelled"
  | "voided"
  | "rejected"
  | "refunded";

export type ProviderRefundStatus = "pending" | "processing" | "succeeded" | "failed" | "cancelled";

/**
 * Card-network transaction context (Forward `order_details`). Who started the
 * payment and whether it is a stored-credential repeat decide which network
 * rules apply: a customer paying at checkout is customer-initiated
 * ("ecommerce" + "customer"); autopay charging a stored method on schedule is
 * merchant-initiated ("recurring" + "merchant" + scheduled).
 */
export type ProviderOrderDetails = {
  card_not_present_type?: "ecommerce" | "recurring";
  initiated_by?: "customer" | "merchant";
  is_scheduled_payment?: boolean;
  invoice_id?: string;
  description?: string;
  tax_amount?: number;
  tax_exempt?: boolean;
  ship_to_zip?: string;
  ship_to_country?: string;
  po_number?: string;
};

/** Billing details sent with a charge (AVS uses the street line and postal code). */
export type ProviderBillingDetails = {
  name?: string;
  email?: string;
  phone?: string;
  address?: {
    address_line1?: string;
    address_line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country?: string;
  };
};

export type ProviderPayoutStatus = "pending" | "in_transit" | "paid" | "failed";

export type ProviderDisputeStatus = "open" | "under_review" | "won" | "lost" | "closed";

export type ProviderPaymentMethodType = "card" | "bank" | "ca_bank";

export type CreatePaymentIntentInput = {
  amount_cents: number;
  currency?: string;
  /** Portion of the amount the merchant keeps (splits deduct the rest). */
  merchant_amount_cents?: number;
  /** Our internal id (payment_intents doc id) for cross-referencing. */
  reference_id?: string;
  /** Which rails the intent accepts, e.g. ["card"] or ["card", "bank"]. */
  payment_method_types?: string[];
  /** Auth-then-capture when false; immediate capture when true/omitted. */
  auto_capture?: boolean;
  description?: string;
  user_fields?: JsonObject;
  order_details?: ProviderOrderDetails;
  /**
   * Stable key for this business operation. A retry of the same operation
   * must send the same key so the processor treats it as one request.
   */
  idempotency_key?: string;
};

export type ProviderPaymentIntent = {
  id: string;
  status: ProviderPaymentIntentStatus;
  amount_cents: number;
  currency: string;
  captured_cents: number;
  refunded_cents: number;
  voided_cents: number;
  reference_id: string;
  /** Hands the browser's secure card/bank element this one intent. */
  client_secret: string;
  settlement_status: string;
  /** The intent's most recent payment attempt, when the provider echoes it. */
  latest_payment: ProviderPayment | null;
  raw: JsonObject;
};

export type UpdatePaymentIntentInput = {
  amount_cents?: number;
  order_details?: ProviderOrderDetails;
  idempotency_key?: string;
};

export type CreatePaymentInput = {
  payment_method_id: string;
  amount_cents?: number;
  billing_details?: ProviderBillingDetails | JsonObject;
  order_details?: ProviderOrderDetails;
  reference_id?: string;
  idempotency_key?: string;
};

export type ProviderPayment = {
  id: string;
  intent_id: string;
  status: ProviderPaymentStatus;
  amount_cents: number;
  currency: string;
  auth_code: string;
  /** Provider decline code (e.g. Forward's `decline_category`). */
  decline_reason: string;
  /** Human-readable decline or failure text from the provider. */
  decline_text: string;
  /** "card" or "bank" (Forward `payment_rail_type`). */
  rail: "card" | "bank";
  /** "settled" | "unsettled" | "" — a payment can be voided until it settles. */
  settlement_status: string;
  payment_method_id: string;
  raw: JsonObject;
};

export type CreateRefundInput = {
  amount_cents?: number;
  reason?: string;
  idempotency_key?: string;
};

export type CancelPaymentIntentInput = {
  reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "abandoned";
  idempotency_key?: string;
};

export type ProviderRefund = {
  id: string;
  payment_id: string;
  status: ProviderRefundStatus;
  amount_cents: number;
  raw: JsonObject;
};

export type ProviderPayout = {
  id: string;
  status: ProviderPayoutStatus;
  amount_cents: number;
  currency: string;
  arrival_date: string;
  raw: JsonObject;
};

export type ProviderBalance = {
  currency: string;
  available_cents: number;
  pending_cents: number;
  raw: JsonObject;
};

export type ProviderDispute = {
  id: string;
  payment_id: string;
  status: ProviderDisputeStatus;
  amount_cents: number;
  reason: string;
  respond_by: string;
  raw: JsonObject;
};

export type SurchargeCalculationInput = {
  amount_cents: number;
  payment_method_id?: string;
  bin?: string;
  state?: string;
};

export type SurchargeCalculation = {
  amount_cents: number;
  surcharge_cents: number;
  total_cents: number;
  raw: JsonObject;
};

export type CreatePaymentMethodIntentInput = {
  type?: ProviderPaymentMethodType;
  /** $0-auth validation with CVV/AVS on save. */
  validate?: boolean;
  billing_details?: JsonObject;
  user_fields?: JsonObject;
  /**
   * MOCK-ONLY direct tokenization payload. The mock adapter derives a
   * pm_mock_* token from brand + last4 and DISCARDS the rest — the PAN/CVC are
   * never persisted anywhere. Real providers ignore these fields entirely:
   * their cards tokenize client-side through the provider SDK element, so raw
   * card data never reaches our servers.
   */
  card?: {
    number?: string;
    exp_month?: number;
    exp_year?: number;
    cvc?: string;
    name?: string;
    zip?: string;
  };
  /** MOCK-ONLY bank tokenization payload (account number never persisted). */
  bank?: {
    routing?: string;
    account?: string;
    account_type?: string;
    name?: string;
  };
};

export type ProviderPaymentMethodIntent = {
  id: string;
  status: string;
  client_secret: string;
  payment_method_id: string;
  raw: JsonObject;
};

export type ProviderPaymentMethod = {
  id: string;
  type: ProviderPaymentMethodType;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  raw: JsonObject;
};

export type UpdatePaymentMethodInput = {
  billing_details?: JsonObject;
  exp_month?: number;
  exp_year?: number;
};

export type ListOptions = {
  limit?: number;
  starting_after?: string;
};

export interface PaymentProviderAdapter {
  readonly provider: string;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  getPaymentIntent(intentId: string): Promise<ProviderPaymentIntent>;
  /** Finds intents by our reference id (reconciles a charge whose response was lost). */
  searchPaymentIntents(input: { reference_id: string }): Promise<ProviderPaymentIntent[]>;
  updatePaymentIntent(intentId: string, input: UpdatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  capturePaymentIntent(intentId: string, input?: { amount_cents?: number; idempotency_key?: string }): Promise<ProviderPaymentIntent>;
  /** Cancels an intent; a captured payment that has not settled is voided. */
  cancelPaymentIntent(intentId: string, input?: CancelPaymentIntentInput): Promise<ProviderPaymentIntent>;
  createPayment(intentId: string, input: CreatePaymentInput): Promise<ProviderPayment>;
  createRefund(intentId: string, input?: CreateRefundInput): Promise<ProviderRefund>;
  getRefund(refundId: string): Promise<ProviderRefund>;
  getPayment(paymentId: string): Promise<ProviderPayment>;
  listPayouts(options?: ListOptions): Promise<ProviderPayout[]>;
  getPayout(payoutId: string): Promise<ProviderPayout>;
  getBalances(): Promise<ProviderBalance[]>;
  listDisputes(options?: ListOptions): Promise<ProviderDispute[]>;
  getDispute(disputeId: string): Promise<ProviderDispute>;
  calculateSurcharge(input: SurchargeCalculationInput): Promise<SurchargeCalculation>;
  createPaymentMethodIntent(input?: CreatePaymentMethodIntentInput): Promise<ProviderPaymentMethodIntent>;
  getPaymentMethod(paymentMethodId: string): Promise<ProviderPaymentMethod>;
  updatePaymentMethod(paymentMethodId: string, input: UpdatePaymentMethodInput): Promise<ProviderPaymentMethod>;
}

// --- Merchant boarding ------------------------------------------------------

export type BoardingApplicationStatus =
  | "DRAFT"
  | "UNDER_REVIEW"
  | "UNDERWRITING"
  | "APPROVED"
  | "NEED_INFORMATION"
  | "CONDITIONALLY_APPROVED"
  | "CREDIT_PENDED"
  | "DECLINED"
  | "CANCELLED"
  // Documented by Forward's boarding reference (docs.getfwd.com) beyond the
  // original plan assumptions:
  | "REEVALUATION_PENDING"
  | "REEVALUATION_APPROVED"
  | "REEVALUATION_DECLINED"
  | "REJECT_BY_SALES"
  | "UNDERWRITING_ERROR"
  | "DECLINE_REEVALUATION_INITIATED";

export type CreateBusinessInput = {
  name: string;
  email?: string;
  phone?: string;
};

export type ProviderBusiness = {
  id: string;
  name: string;
  raw: JsonObject;
};

export type ApplicationInput = {
  business_id?: string;
  /** Merchant account display name (required by Forward on create). */
  name?: string;
  processing_plan_id?: string;
  /** Persists our org id through application -> account. */
  external_account_id?: string;
  company?: JsonObject;
  address?: JsonObject;
  owners?: JsonObject[];
  volumes?: JsonObject;
  /**
   * Payout bank account collected by the onboarding wizard
   * ({routing_number, account_number, account_type, holder_name}). The mock
   * adapter stores it on the application; Forward has no documented
   * application-level slot for it, so the Forward adapter carries it under
   * user_fields.bank_account.
   */
  bank_account?: JsonObject;
  user_fields?: JsonObject;
  /** Forward hosted application return destination and other partner metadata. */
  partner_data?: JsonObject;
};

export type ProviderApplication = {
  id: string;
  business_id: string;
  status: BoardingApplicationStatus;
  processing_plan_id: string;
  documents_requested: JsonObject[];
  raw: JsonObject;
};

export type ProviderProcessingPlan = {
  id: string;
  name: string;
  raw: JsonObject;
};

export type ProviderAccount = {
  id: string;
  business_id: string;
  external_account_id: string;
  processing_enabled: boolean;
  payouts_enabled: boolean;
  /** Provider account status (Forward: BOARDING until the gateway is set up). */
  status: string;
  /** Gateway merchant id once the account is boarded to the gateway. */
  gateway_mid: string;
  raw: JsonObject;
};

export type ProviderMcc = {
  code: string;
  description: string;
  active: boolean;
};

export type ProviderBankAccount = {
  id: string;
  business_id: string;
  name: string;
  mask: string;
  validation_status: string;
  verification_status: string;
  status: string;
  active: boolean;
  country: string;
  created_at: string;
  updated_at: string;
  removed_at: string;
  needs_info_comments: string;
  needs_info_documents: JsonObject[];
  /** Compatibility aliases for older settings consumers. */
  bank_name: string;
  last4: string;
  raw: JsonObject;
};

export type BankAccountListOptions = ListOptions & {
  business_id?: string;
  status?: string;
  created_from?: string;
  country?: string;
};

/**
 * Hosted application link (LIVE-VERIFIED 2026-08-14): Forward returns
 * `{ link_id, uri, expiration_date, expired }` from
 * POST /applications/{id}/link — 14-day expiry, regenerable at will (each POST
 * mints a fresh link; older links keep working until they expire).
 */
export type ProviderApplicationLink = {
  id: string;
  url: string;
  expires_at: string;
  expired: boolean;
  raw: JsonObject;
};

export type PortalUserInput = {
  /** Provider business the merchant-portal user belongs to. */
  business_id?: string;
  /** Full display name; split into first/last when the wire needs it. */
  name?: string;
  first_name?: string;
  last_name?: string;
  email: string;
};

export type ProviderPortalUser = {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  raw: JsonObject;
};

/** Single-use passwordless login link into the provider's merchant portal. */
export type ProviderPortalLoginUrl = {
  user_id: string;
  url: string;
  raw: JsonObject;
};

export interface MerchantBoardingAdapter {
  readonly provider: string;
  createBusiness(input: CreateBusinessInput): Promise<ProviderBusiness>;
  createApplication(input: ApplicationInput): Promise<ProviderApplication>;
  updateApplication(applicationId: string, input: ApplicationInput): Promise<ProviderApplication>;
  getApplication(applicationId: string): Promise<ProviderApplication>;
  /**
   * PARTNER-CAPABILITY-GATED (rep-confirmed 2026-08-14): direct API submission
   * (`PUT /applications/{id}/submit`) is not available to partners — full
   * underwriting submission requires the merchant to complete Forward's HOSTED
   * application workflow (signatures included). Kept in the interface because
   * it still validates the payload and may be enabled for some integrations;
   * the org-facing flow must NOT depend on it — use
   * generateApplicationLink() and hand the merchant to the hosted form.
   */
  submitApplication(applicationId: string): Promise<ProviderApplication>;
  /** Generates (or regenerates) the hosted application link for a merchant. */
  generateApplicationLink(applicationId: string): Promise<ProviderApplicationLink>;
  /** Creates a merchant-portal user (bank changes + dispute responses are portal-only). */
  createPortalUser(input: PortalUserInput): Promise<ProviderPortalUser>;
  /** Finds an existing portal user by email (and business), else creates one. */
  ensurePortalUser(input: PortalUserInput): Promise<ProviderPortalUser>;
  /** Mints a single-use magic-link login URL into the provider's merchant portal. */
  generatePortalLoginUrl(userId: string): Promise<ProviderPortalLoginUrl>;
  listProcessingPlans(options?: ListOptions): Promise<ProviderProcessingPlan[]>;
  /** Merchant category codes assigned to the partner, for the application form. */
  listMccs(): Promise<ProviderMcc[]>;
  getAccount(accountId: string): Promise<ProviderAccount>;
  /**
   * Lists the partner's merchant accounts (optionally scoped to a business).
   * Approval delivers the account id via webhooks; environments without a
   * registered webhook endpoint discover it through this read instead.
   */
  listAccounts(options?: ListOptions & { business_id?: string }): Promise<ProviderAccount[]>;
  listBankAccounts(options?: BankAccountListOptions): Promise<ProviderBankAccount[]>;
}
