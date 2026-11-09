"""AeroShield backend test suite.

This file is load-bearing, not ceremonial. With it present, pytest walks up past the
package and puts `backend/` on sys.path, which is what makes both `import app` and
`from tests.conftest import auth` resolve. Without it, pytest would put
`backend/tests/` on sys.path instead and neither import would work.
"""
