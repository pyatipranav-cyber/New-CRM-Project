'use strict';
// Versioned, forward-only migrations. Never edit a migration that has been
// deployed; add a new one with the next version number instead.

const TENANT_TABLES = ['customers', 'enquiries', 'follow_ups', 'status_history'];

const rls = TENANT_TABLES.map(
  (t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);`
).join('\n');

module.exports = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE businesses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  phone             text,
  city              text,
  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  country_code      text NOT NULL DEFAULT '91' CHECK (country_code ~ '^[0-9]{1,4}$'),
  whatsapp_template text NOT NULL DEFAULT 'Hello {name}, this is {business}. Thank you for your interest in {product}. Would you like more details or a convenient time to visit us?',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  email          text NOT NULL CHECK (char_length(email) <= 254),
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'staff')),
  is_active      boolean NOT NULL DEFAULT true,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  token_version  integer NOT NULL DEFAULT 0,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_business_idx ON users (business_id);

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mobile      text NOT NULL CHECK (mobile ~ '^[0-9]{8,15}$'),
  notes       text CHECK (char_length(notes) <= 2000),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_mobile_per_business UNIQUE (business_id, mobile),
  CONSTRAINT customers_id_business UNIQUE (id, business_id)
);

CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL,
  product         text NOT NULL CHECK (char_length(product) BETWEEN 1 AND 160),
  source          text NOT NULL CHECK (source IN ('walk_in','phone','whatsapp','online','referral','other')),
  estimated_value numeric(14,2) CHECK (estimated_value >= 0),
  enquiry_date    date NOT NULL DEFAULT CURRENT_DATE,
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new','interested','follow_up','converted','lost')),
  sale_value      numeric(14,2) CHECK (sale_value >= 0),
  lost_reason     text CHECK (char_length(lost_reason) <= 300),
  closed_at       timestamptz,
  notes           text CHECK (char_length(notes) <= 2000),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enquiries_customer_same_business
    FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE CASCADE,
  CONSTRAINT enquiries_id_business UNIQUE (id, business_id)
);
CREATE INDEX enquiries_business_status_idx ON enquiries (business_id, status);
CREATE INDEX enquiries_customer_idx ON enquiries (customer_id);

CREATE TABLE follow_ups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  enquiry_id   uuid NOT NULL,
  due_date     date NOT NULL,
  due_time     time,
  note         text CHECK (char_length(note) <= 1000),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled')),
  outcome      text CHECK (char_length(outcome) <= 1000),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_ups_enquiry_same_business
    FOREIGN KEY (enquiry_id, business_id) REFERENCES enquiries(id, business_id) ON DELETE CASCADE
);
CREATE INDEX follow_ups_due_idx ON follow_ups (business_id, status, due_date);
CREATE INDEX follow_ups_enquiry_idx ON follow_ups (enquiry_id);

CREATE TABLE status_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  enquiry_id  uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  note        text CHECK (char_length(note) <= 1000),
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT status_history_enquiry_same_business
    FOREIGN KEY (enquiry_id, business_id) REFERENCES enquiries(id, business_id) ON DELETE CASCADE
);
CREATE INDEX status_history_enquiry_idx ON status_history (enquiry_id, changed_at);

${rls}
`,
  },
];
