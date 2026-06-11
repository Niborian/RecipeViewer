import { Link } from 'react-router-dom';

function Header() {
  return (
    <header className="bg-gray-800 text-white shadow-lg border-b border-gray-700">
      <div className="container mx-auto px-6">
        <div className="flex items-center h-16">
          <Link to="/" className="text-xl font-bold hover:text-cyan-400 transition">
            Recipe Viewer
          </Link>
          <div className="w-px h-8 bg-gray-600 mx-6" />
          <nav className="flex items-center gap-6">
            <Link to="/items" className="hover:text-cyan-400 transition">
              Items
            </Link>
            <Link to="/fluids" className="hover:text-cyan-400 transition">
              Fluids
            </Link>
            <Link to="/materials" className="hover:text-cyan-400 transition">
              Materials
            </Link>
            <Link to="/recipes" className="hover:text-cyan-400 transition">
              Recipes
            </Link>
            <Link to="/simulate" className="hover:text-cyan-400 transition">
              Simulate
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

export default Header;
