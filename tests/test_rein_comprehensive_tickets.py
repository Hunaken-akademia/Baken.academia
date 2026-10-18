import unittest
import numpy as np
from scripts.rein_comprehensive_tickets import fast_candidates
from scripts.nar_ticket_research import generate_candidates,METHODS

class FastTicketTest(unittest.TestCase):
 def test_vectorized_generator_matches_existing_order(self):
  rng=np.random.default_rng(712)
  for n in [6,9,12]:
   horses=[(i+1,min(8,i//2+1)) for i in range(n)];roles=rng.uniform(.01,1,(n,3));pop=rng.permutation(n)+1
   for method in METHODS:
    old=generate_candidates(horses,roles,pop,method);new=fast_candidates(horses,roles,pop,method)
    for bet in old:self.assertEqual([ticket for ticket,score in old[bet]][:30],new[bet][:30],(n,method,bet))
if __name__=='__main__':unittest.main()
