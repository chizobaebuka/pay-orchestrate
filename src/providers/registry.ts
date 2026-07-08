import { ProviderName } from "../db/entities/transaction";
import { PaymentProviderAdapter } from "./provider-adapter.interface";
import { stripeAdapter } from "./stripe.adapter";
import { paystackAdapter } from "./paystack.adapter";

export const adapters: Record<ProviderName, PaymentProviderAdapter> = {
    [ProviderName.STRIPE]: stripeAdapter,
    [ProviderName.PAYSTACK]: paystackAdapter,
};
