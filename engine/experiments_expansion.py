from modules.expansion import DedrisExpansion

expansion = DedrisExpansion()

text = 'a handsome man'

for i in range(64):
    print(expansion(text, seed=i))
