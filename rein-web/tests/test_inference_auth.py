import io
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import rein_score


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def token(self, **changes):
        claims = dict(iss=rein_score.ISSUER, aud=rein_score.AUDIENCE,
                      iat=int(time.time()), exp=int(time.time()) + 60,
                      owner_id='team_JoV13Y5pkEXrjvf8JCKP6tNY',
                      project_id='prj_8X6LIxRxvKKNyVQWxFKF6AQJ6wrm', environment='production')
        claims.update(changes)
        return jwt.encode(claims, self.key, algorithm='RS256', headers={'kid': 'test'})

    def test_signature_expiry_and_project(self):
        with patch.object(rein_score._jwks, 'get_signing_key_from_jwt', return_value=SimpleNamespace(key=self.key.public_key())):
            rein_score.authorize(self.token())
            for changes in [dict(exp=1), dict(project_id='other'), dict(owner_id='other'),
                            dict(environment='development'), dict(aud='other'), dict(iss='other')]:
                with self.assertRaises(jwt.InvalidTokenError):
                    rein_score.authorize(self.token(**changes))
            other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            with self.assertRaises(jwt.InvalidTokenError):
                rein_score.authorize(jwt.encode({'exp': int(time.time()) + 60}, other_key, algorithm='RS256'))

    def test_missing_token_never_reaches_cold_or_warm_runtime(self):
        for runtime in [None, object()]:
            instance = object.__new__(rein_score.handler)
            instance.headers = {'content-length': '2'}
            instance.rfile = io.BytesIO(b'{}')
            instance.wfile = io.BytesIO()
            status = []
            instance.send_response = status.append
            instance.send_header = lambda *args: None
            instance.end_headers = lambda: None
            with patch.object(rein_score, '_runtime', runtime), patch.object(rein_score, 'get_runtime') as load:
                instance.do_POST()
                load.assert_not_called()
            self.assertEqual(status, [401])
            self.assertEqual(json.loads(instance.wfile.getvalue()), {'error': 'Unauthorized'})




class RuntimeRefreshTests(unittest.TestCase):
    def test_warm_runtime_checks_registry_after_five_minutes_without_redownloading_unchanged_bundle(self):
        runtime=object()
        with patch.object(rein_score,'_runtime',runtime), patch.object(rein_score,'_runtime_version','v1'), patch.object(rein_score,'_runtime_checked_at',100), patch.object(rein_score.time,'monotonic',return_value=200), patch.object(rein_score,'_request_registry',return_value={'model':{'version':'v1'}}) as registry, patch.object(rein_score,'_request_bundle') as download:
            self.assertIs(rein_score.get_runtime('token'),runtime)
            registry.assert_not_called()
            with patch.object(rein_score.time,'monotonic',return_value=401):
                self.assertIs(rein_score.get_runtime('token'),runtime)
            registry.assert_called_once()
            download.assert_not_called()

    def test_new_version_replaces_loaded_runtime_only_after_successful_load(self):
        import tempfile
        old,new=object(),object()
        with tempfile.TemporaryDirectory() as folder:
            destination=Path(folder)/'rein-runtime'/'v2'
            destination.mkdir(parents=True);(destination/'schema.json').write_text('{}')
            fake=SimpleNamespace(ReinRuntime=SimpleNamespace(load=lambda *args:new))
            with patch.dict(sys.modules,{'rein_augmented_runtime':fake}), patch.object(rein_score,'_runtime',old), patch.object(rein_score,'_runtime_version','v1'), patch.object(rein_score,'_runtime_checked_at',0), patch.object(rein_score.time,'monotonic',return_value=400), patch.object(rein_score.tempfile,'gettempdir',return_value=folder), patch.object(rein_score,'_request_registry',return_value={'model':{'version':'v2'}}), patch.object(rein_score,'_request_bundle',return_value=({},b'checked')):
                self.assertIs(rein_score.get_runtime('token'),new)
                self.assertEqual(rein_score._runtime_version,'v2')

if __name__ == '__main__':
    unittest.main()
