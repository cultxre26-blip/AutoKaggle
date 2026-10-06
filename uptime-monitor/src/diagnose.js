// Turns raw check errors into a plain-English cause and a suggested fix.
const RULES = [
  { match: (e) => e === 'ENOTFOUND' || e === 'EAI_AGAIN', code: 'dns', title: 'DNS lookup failed',
    fix: 'The domain does not resolve. Check that the domain has not expired and that its A/AAAA/CNAME records exist at your DNS provider.' },
  { match: (e) => e === 'ECONNREFUSED', code: 'refused', title: 'Connection refused',
    fix: 'The server is reachable but nothing is listening on that port. Restart the web server or app process and check the port and firewall.' },
  { match: (e) => e === 'ECONNRESET' || e === 'EPIPE', code: 'reset', title: 'Connection dropped',
    fix: 'The server closed the connection mid-request. Look for crashes or out-of-memory kills, and for a proxy or firewall cutting connections.' },
  { match: (e) => e === 'ETIMEDOUT' || e === 'EHOSTUNREACH' || e === 'ENETUNREACH' || /Timed out/.test(e), code: 'timeout', title: 'Request timed out',
    fix: 'The server did not answer in time. Check for an overloaded server, a hung database query or a firewall silently dropping traffic.' },
  { match: (e) => e === 'CERT_HAS_EXPIRED', code: 'tls_expired', title: 'SSL certificate has expired',
    fix: 'Renew the certificate now. If you use Let\'s Encrypt, check that the renewal job (certbot or your platform) is running.' },
  { match: (e) => /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED/.test(e), code: 'tls_untrusted', title: 'SSL certificate is not trusted',
    fix: 'The certificate is self-signed or the intermediate chain is missing. Install the full chain from your certificate authority.' },
  { match: (e) => /ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH/.test(e), code: 'tls_hostname', title: 'SSL certificate does not match the domain',
    fix: 'The certificate was issued for a different hostname. Reissue it to include this exact domain.' },
  { match: (e) => /^ERR_SSL|EPROTO|ERR_TLS/.test(e), code: 'tls_error', title: 'SSL handshake failed',
    fix: 'The TLS handshake failed. Check the server\'s TLS configuration, supported protocol versions and certificate installation.' },
  { match: (e) => e === 'KEYWORD_MISSING', code: 'content', title: 'Page is up but the expected text is missing',
    fix: 'The server responded, but the page does not contain your keyword. It may be showing an error page, a maintenance page or broken content. Open the page and check.' },
  { match: (e) => /^HTTP 5/.test(e), code: 'server_error', title: 'Server error',
    fix: 'The application returned a 5xx error. Check the application and web server error logs around the time of the failure, and recent deployments.' },
  { match: (e) => e === 'HTTP 404', code: 'not_found', title: 'Page not found',
    fix: 'The URL returns 404. It may have moved or been removed, or a deployment broke routing. Update the monitored URL or restore the page.' },
  { match: (e) => e === 'HTTP 401' || e === 'HTTP 403', code: 'forbidden', title: 'Access denied',
    fix: 'The server refuses the request. Check for a firewall, bot protection or auth rule blocking the PingWatch user agent, or monitor a public URL.' },
  { match: (e) => /^HTTP 4/.test(e), code: 'client_error', title: 'Request rejected',
    fix: 'The server returned a 4xx response. Check that the monitored URL is correct and publicly reachable.' },
  { match: (e) => /private|reserved/i.test(e), code: 'blocked', title: 'Target is a private address',
    fix: 'PingWatch can only monitor public internet addresses. Use a public hostname.' },
];

export function diagnose(error) {
  if (!error) return null;
  const rule = RULES.find((r) => r.match(String(error)));
  return rule
    ? { code: rule.code, title: rule.title, fix: rule.fix }
    : { code: 'unknown', title: 'Check failed', fix: `The check failed with: ${error}. Open the URL in a browser and check the server logs.` };
}
