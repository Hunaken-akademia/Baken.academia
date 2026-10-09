import io
import unittest
import urllib.error
from unittest.mock import patch

from scripts.refresh_rein_history import open_with_retry


class HistoryRetryTest(unittest.TestCase):
    def test_transient_oidc_failure_recovers(self):
        response = io.BytesIO(b'{"value":"test"}')
        failure = urllib.error.HTTPError('https://example.test', 503, 'Unavailable', {}, None)
        with patch('urllib.request.urlopen', side_effect=[failure, response]) as request, patch('time.sleep') as sleep:
            self.assertIs(open_with_retry('https://example.test', 30), response)
            self.assertEqual(request.call_count, 2)
            sleep.assert_called_once_with(2)

    def test_auth_failure_is_not_retried(self):
        failure = urllib.error.HTTPError('https://example.test', 403, 'Forbidden', {}, None)
        with patch('urllib.request.urlopen', side_effect=failure) as request, patch('time.sleep') as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                open_with_retry('https://example.test', 30)
            self.assertEqual(request.call_count, 1)
            sleep.assert_not_called()

    def test_network_failure_has_bounded_retries(self):
        with patch('urllib.request.urlopen', side_effect=urllib.error.URLError('timeout')) as request, patch('time.sleep') as sleep:
            with self.assertRaises(urllib.error.URLError):
                open_with_retry('https://example.test', 30)
            self.assertEqual(request.call_count, 5)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 4, 8, 16])


if __name__ == '__main__':
    unittest.main()
