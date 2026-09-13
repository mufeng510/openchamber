import dns from 'node:dns';
import net from 'node:net';

/**
 * Host policy for provider model discovery.
 *
 * Discovery sends a credentialed GET to a URL the user typed, so it is the one
 * place in the provider flow where OpenChamber reaches an arbitrary host on the
 * user's behalf. The rules below keep that GET from reaching loopback, LAN,
 * overlay, and cloud metadata addresses. Hosts that only the local machine can
 * reach are refused by default; set
 * OPENCHAMBER_PROVIDER_DISCOVERY_ALLOW_PRIVATE=1 to opt into them (local model
 * servers built on private addresses).
 *
 * The caller resolves the host and then fetches it, so a DNS record that
 * changes between the two lookups could still reach a blocked address. The
 * model-list path and the no-redirect policy keep that window narrow, and the
 * request only happens on an explicit click in the user's own settings.
 *
 * Hostnames are canonicalized through the WHATWG URL parser before
 * classification so numeric/hex/shortened IPv4 spellings (2130706433,
 * 0x7f000001, 127.1) and IPv4-mapped IPv6 (`::ffff:7f00:1`) are seen as the
 * real targets the fetch would open, not opaque strings.
 */

const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

// Cloud metadata endpoints answer credentials to whoever asks; they stay
// blocked even when private addresses are allowed.
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

// Link-local and unspecified addresses. Blocked in every mode.
const isAlwaysBlockedIpv4 = (octets) => {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / this network)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link local, includes 169.254.169.254)
  return false;
};

const isPrivateIpv4 = (octets) => {
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / Tailscale)
  return false;
};

const parseIpv4Octets = (address) => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets;
};

const isAlwaysBlockedIpv6 = (address) => {
  const normalized = address.toLowerCase();
  if (normalized === '::' ) return true; // unspecified
  return /^fe[89ab]/.test(normalized); // fe80::/10 (link local)
};

const isPrivateIpv6 = (address) => {
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true; // loopback
  return /^f[cd]/.test(normalized); // fc00::/7 (unique local)
};

const stripBrackets = (hostname) => hostname.replace(/^\[/, '').replace(/\]$/, '');

/**
 * Re-render a hostname through the WHATWG URL parser so numeric IPv4 spellings
 * (2130706433, 0x7f000001, 127.1) canonicalize to real dotted quad. The parser
 * is the same one `fetch` uses, so what survives classification is what the
 * network stack will actually connect to. Falls back on the input when the
 * host is not a valid URL host on its own (it may still be resolvable).
 */
export function canonicalizeDiscoveryHostname(hostname) {
  try {
    return new URL(`http://${hostname}`).hostname;
  } catch {
    return hostname;
  }
}

/**
 * Extract the IPv4 address embedded in an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d`, `::ffff:xxxx:xxxx`). The map makes the traffic land on
 * the IPv4 address, so classifying it as plain IPv6 misses loopback and LAN
 * targets. Returns the octets, or null when the address is not a v4 map.
 */
const extractEmbeddedIpv4Octets = (address) => {
  const dotted = address.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    return parseIpv4Octets(dotted.slice(1).join('.'));
  }
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const high = parseInt(hex[1].padStart(4, '0'), 16);
    const low = parseInt(hex[2].padStart(4, '0'), 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff];
  }
  return null;
};

/**
 * Classify an IP literal. Returns 'blocked', 'private', or null (public).
 * `blocked` always wins, so metadata/link-local stay refused even in
 * allow-private mode.
 */
export function classifyDiscoveryAddress(address) {
  const value = stripBrackets(address.trim());
  const family = net.isIP(value);
  if (family === 4) {
    const octets = parseIpv4Octets(value);
    if (!octets) return null;
    if (isAlwaysBlockedIpv4(octets)) return 'blocked';
    if (isPrivateIpv4(octets)) return 'private';
    return null;
  }
  if (family === 6) {
    if (isAlwaysBlockedIpv6(value)) return 'blocked';
    if (isPrivateIpv6(value)) return 'private';
    const embedded = extractEmbeddedIpv4Octets(value);
    if (embedded) {
      if (isAlwaysBlockedIpv4(embedded)) return 'blocked';
      if (isPrivateIpv4(embedded)) return 'private';
    }
    return null;
  }
  return null;
}

/**
 * Classify a hostname that is not an IP literal. Suffix and metadata-name
 * checks only; DNS resolution is separate.
 */
export function classifyDiscoveryHostname(hostname) {
  const value = canonicalizeDiscoveryHostname(hostname).trim().toLowerCase();
  if (!value) return 'blocked';
  if (METADATA_HOSTNAMES.has(value)) return 'blocked';
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => value.endsWith(suffix))) return 'private';
  if (value === 'localhost' || value === 'localhost.localdomain') return 'private';
  return null;
}

const defaultLookup = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * True when any address the hostname resolves to is blocked or private.
 * A lookup failure returns { resolved: false }: the caller lets the fetch
 * surface the network error instead of reporting a policy rejection.
 */
export async function hostnameResolvesToRestrictedAddress(hostname, { allowPrivate, lookup = defaultLookup } = {}) {
  let records;
  try {
    records = await lookup(canonicalizeDiscoveryHostname(hostname));
  } catch {
    return { resolved: false, restricted: false };
  }

  const list = Array.isArray(records) ? records : [records];
  for (const record of list) {
    const address = typeof record?.address === 'string' ? record.address : '';
    if (!address) continue;
    const kind = classifyDiscoveryAddress(address);
    if (kind === 'blocked') return { resolved: true, restricted: true };
    if (kind === 'private' && !allowPrivate) return { resolved: true, restricted: true };
  }
  return { resolved: true, restricted: false };
}
