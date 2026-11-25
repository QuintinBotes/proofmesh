require_relative '../lib/shapes'

RSpec.describe 'shapes' do
  it 'totals two' do
    expect(total([Circle.new(1), Square.new(2)])).to eq(7)
  end
end
